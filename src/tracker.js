// Canlı servis durumu: konum, sefer, duraklar, varış süreleri ve veli bildirimleri.
import { EventEmitter } from 'node:events';
import { db, today } from './db.js';
import { planRoute, projectOnRoute, haversine } from './routing.js';

const DWELL = Number(process.env.STOP_DWELL_SEC || 45); // her durakta ortalama bekleme (sn)
const ARRIVE_RADIUS = Number(process.env.ARRIVE_RADIUS_M || 60); // durağa varıldı sayılma mesafesi
const NEAR_MIN = Number(process.env.NEAR_NOTIFY_MIN || 5); // "X dk kaldı" bildirimi
const OFF_ROUTE_M = 250; // bu kadar sapma olursa rota yeniden hesaplanır
const STALE_MS = 2 * 60 * 1000; // konum bu kadar eskiyse "güncel değil"

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** 'update' (busId) ve 'notify' ({studentId, text, kind}) olayları */
export const events = new EventEmitter();
events.setMaxListeners(0);

const state = new Map(); // busId -> { pos, trip }
const messages = new Map(); // studentId -> [{at, text, kind}]

function busState(busId) {
  if (!state.has(busId)) state.set(busId, { pos: null, trip: null });
  return state.get(busId);
}

function notify(studentId, text, kind) {
  const list = messages.get(studentId) || [];
  list.unshift({ at: Date.now(), text, kind });
  messages.set(studentId, list.slice(0, 20));
  events.emit('notify', { studentId, text, kind });
}

const riders = (trip) => trip.stops.filter((s) => s.kind === 'student').map((s) => s.studentId);

// --- Sefer --------------------------------------------------------------

/** type: 'morning' (evlerden okula) | 'afternoon' (okuldan evlere) */
export async function startTrip(busId, type) {
  if (!['morning', 'afternoon'].includes(type)) throw new HttpError(400, 'Geçersiz sefer tipi');
  const bus = db.prepare('SELECT * FROM buses WHERE id = ?').get(busId);
  if (!bus) throw new HttpError(404, 'Servis bulunamadı');
  const school = bus.school_id && db.prepare('SELECT * FROM schools WHERE id = ?').get(bus.school_id);
  if (!school) throw new HttpError(400, 'Bu servise okul atanmamış');

  const students = db.prepare(`
    SELECT * FROM students
    WHERE bus_id = ? AND lat IS NOT NULL AND lng IS NOT NULL
      AND (absent_on IS NULL OR absent_on <> ?)
    ORDER BY stop_order, id`).all(busId, today());

  const studentStops = students.map((s) => ({
    kind: 'student', studentId: s.id, name: s.name, lat: s.lat, lng: s.lng,
  }));
  const schoolStop = { kind: 'school', name: school.name, lat: school.lat, lng: school.lng };
  // Akşam: okuldan çıkar, sabahki sıranın tersiyle bırakır
  const stops = type === 'morning' ? [...studentStops, schoolStop] : studentStops.reverse();
  if (stops.length === 0) throw new HttpError(400, 'Bu seferde bırakılacak öğrenci yok');
  for (const s of stops) Object.assign(s, { done: false, doneAt: null, nearNotified: false });

  const st = busState(busId);
  if (type === 'afternoon' && !st.pos) st.pos = { lat: school.lat, lng: school.lng, at: Date.now() };

  st.trip = { type, stops, startedAt: Date.now(), finishedAt: null, route: null, progress: { idx: 0, dur: 0 } };
  await replan(busId);

  const text = type === 'morning' ? 'Servis yola çıktı.' : 'Servis okuldan yola çıktı.';
  for (const id of riders(st.trip)) notify(id, text, 'start');
  events.emit('update', busId);
  return st.trip;
}

export function endTrip(busId) {
  const st = busState(busId);
  if (st.trip && !st.trip.finishedAt) st.trip.finishedAt = Date.now();
  events.emit('update', busId);
}

async function replan(busId) {
  const st = busState(busId);
  const trip = st.trip;
  const remaining = trip.stops.filter((s) => !s.done);
  if (remaining.length === 0) return;
  const start = st.pos ? [[st.pos.lat, st.pos.lng]] : [];
  const route = await planRoute([...start, ...remaining.map((s) => [s.lat, s.lng])]);
  if (st.trip !== trip) return; // bu arada sefer değiştiyse
  remaining.forEach((s, i) => { s.routeDur = route.cumDur[route.stopIdx[i + start.length]]; });
  trip.route = route;
  trip.progress = { idx: 0, dur: 0 };
  trip.replannedAt = Date.now();
}

function markDone(busId, stop) {
  const trip = busState(busId).trip;
  stop.done = true;
  stop.doneAt = Date.now();
  if (stop.kind === 'student') {
    notify(stop.studentId,
      trip.type === 'morning' ? 'Servis evinize ulaştı.' : 'Servis evinize ulaştı, öğrenci indi.',
      'arrived');
  } else {
    for (const id of riders(trip)) notify(id, `Servis okula ulaştı (${stop.name}).`, 'school');
  }
  if (trip.stops.every((s) => s.done)) trip.finishedAt = Date.now();
}

// --- Konum güncelleme ---------------------------------------------------

export async function updatePosition(busId, lat, lng, extra = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(400, 'Geçersiz konum');
  const st = busState(busId);
  st.pos = { lat, lng, speed: extra.speed ?? null, accuracy: extra.accuracy ?? null, at: Date.now() };

  const trip = st.trip;
  if (trip && !trip.finishedAt && trip.route) {
    const pos = [lat, lng];
    const pr = projectOnRoute(trip.route, pos, trip.progress.idx);
    if (pr.dist > OFF_ROUTE_M && Date.now() - trip.replannedAt > 60_000) {
      await replan(busId); // servis güzergâhtan çıktı: kalan duraklar için yeni rota
    } else {
      trip.progress = { idx: pr.idx, dur: pr.dur };
    }

    // Sıradaki durağa varıldı mı? (GPS durağı ıskalarsa rota üzerinde geçilmişse de say)
    for (;;) {
      const next = trip.stops.find((s) => !s.done);
      if (!next) break;
      const close = haversine(pos, [next.lat, next.lng]) < ARRIVE_RADIUS;
      const passed = trip.progress.dur > next.routeDur + 90 && trip.stops.some((s) => !s.done && s !== next);
      if (!close && !passed) break;
      markDone(busId, next);
    }

    // "X dk kaldı" bildirimleri
    for (const e of computeEtas(trip)) {
      if (e.stop.kind === 'student' && !e.stop.nearNotified && e.etaSec <= NEAR_MIN * 60) {
        e.stop.nearNotified = true;
        const min = Math.max(1, Math.round(e.etaSec / 60));
        notify(e.stop.studentId, `Servis yaklaşık ${min} dakika sonra evinizde.`, 'near');
      }
    }
  }
  events.emit('update', busId);
}

/** Kalan duraklar için tahmini varış süreleri */
function computeEtas(trip) {
  if (!trip || trip.finishedAt || !trip.route) return [];
  const cur = trip.progress.dur;
  let studentsBefore = 0;
  const out = [];
  for (const stop of trip.stops) {
    if (stop.done) continue;
    const etaSec = Math.max(0, stop.routeDur - cur) + studentsBefore * DWELL;
    out.push({ stop, etaSec: Math.round(etaSec), stopsBefore: studentsBefore });
    if (stop.kind === 'student') studentsBefore++;
  }
  return out;
}

// --- Gelmeyecek bildirimi ------------------------------------------------

export async function setAbsent(studentId, absent) {
  db.prepare('UPDATE students SET absent_on = ? WHERE id = ?').run(absent ? today() : null, studentId);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if (!absent || !student?.bus_id) return;
  const st = busState(student.bus_id);
  const trip = st.trip;
  if (trip && !trip.finishedAt) {
    const i = trip.stops.findIndex((s) => s.studentId === studentId && !s.done);
    if (i >= 0) {
      trip.stops.splice(i, 1);
      await replan(student.bus_id); // diğer velilerin süresi kısalır
      events.emit('update', student.bus_id);
    }
  }
}

// --- Görünümler ----------------------------------------------------------

const isStale = (pos) => !pos || Date.now() - pos.at > STALE_MS;

/** Veliye gösterilecek bilgi. Gizlilik: başka öğrencilerin adres/adı yok. */
export function parentView(student) {
  const bus = student.bus_id && db.prepare('SELECT * FROM buses WHERE id = ?').get(student.bus_id);
  const school = bus?.school_id && db.prepare('SELECT * FROM schools WHERE id = ?').get(bus.school_id);
  const st = bus ? busState(bus.id) : { pos: null, trip: null };
  const trip = st.trip;
  const etas = computeEtas(trip);

  let tripView = null;
  if (trip) {
    const my = trip.stops.find((s) => s.studentId === student.id);
    const myEta = etas.find((e) => e.stop === my);
    const schoolStop = trip.stops.find((s) => s.kind === 'school');
    const schoolEta = etas.find((e) => e.stop === schoolStop);
    tripView = {
      type: trip.type,
      startedAt: trip.startedAt,
      finishedAt: trip.finishedAt,
      onTrip: !!my,
      myStop: my ? { done: my.done, doneAt: my.doneAt, etaSec: myEta?.etaSec ?? null, stopsBefore: myEta?.stopsBefore ?? 0 } : null,
      school: schoolStop ? { done: schoolStop.done, doneAt: schoolStop.doneAt, etaSec: schoolEta?.etaSec ?? null } : null,
    };
  }

  const active = trip && !trip.finishedAt;
  return {
    student: {
      name: student.name,
      home: student.lat != null ? { lat: student.lat, lng: student.lng } : null,
      absentToday: student.absent_on === today(),
    },
    bus: bus ? { name: bus.name, plate: bus.plate, driverName: bus.driver_name, driverPhone: bus.driver_phone } : null,
    school: school ? { name: school.name, lat: school.lat, lng: school.lng } : null,
    trip: tripView,
    // Servis konumu sadece sefer sırasında gösterilir
    busPos: active && st.pos ? { lat: st.pos.lat, lng: st.pos.lng, at: st.pos.at, stale: isStale(st.pos) } : null,
    messages: messages.get(student.id) || [],
    now: Date.now(),
  };
}

/** Şoför ve yönetici için servis durumu (tüm duraklar, isimlerle) */
export function busView(busId) {
  const st = busState(busId);
  const trip = st.trip;
  const etas = computeEtas(trip);
  return {
    pos: st.pos ? { ...st.pos, stale: isStale(st.pos) } : null,
    trip: trip && {
      type: trip.type,
      startedAt: trip.startedAt,
      finishedAt: trip.finishedAt,
      routeSource: trip.route?.source,
      stops: trip.stops.map((s) => {
        const e = etas.find((x) => x.stop === s);
        return { kind: s.kind, studentId: s.studentId, name: s.name, lat: s.lat, lng: s.lng, done: s.done, doneAt: s.doneAt, etaSec: e?.etaSec ?? null };
      }),
    },
  };
}

export function getTrip(busId) {
  return busState(busId).trip;
}

export function forgetBus(busId) {
  state.delete(busId);
}
