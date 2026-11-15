// Canlı servis durumu: konum, sefer, duraklar, yoklama, varış süreleri ve veli bildirimleri.
import { EventEmitter } from 'node:events';
import { db, today } from './db.js';
import { planRoute, projectOnRoute, haversine } from './routing.js';
import { pushToStudent } from './push.js';

const DWELL = Number(process.env.STOP_DWELL_SEC || 45); // her durakta ortalama bekleme (sn)
const ARRIVE_RADIUS = Number(process.env.ARRIVE_RADIUS_M || 60); // durağa varıldı sayılma mesafesi
const OFF_ROUTE_M = 250; // bu kadar sapma olursa rota yeniden hesaplanır
const STALE_MS = 2 * 60 * 1000; // konum bu kadar eskiyse "güncel değil"

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
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

const hhmm = (ts) => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ_NAME || 'Europe/Istanbul' });

function notify(studentId, text, kind, { urgent = false } = {}) {
  const list = messages.get(studentId) || [];
  list.unshift({ at: Date.now(), text, kind, urgent });
  messages.set(studentId, list.slice(0, 30));
  events.emit('notify', { studentId, text, kind, urgent });
  const s = db.prepare('SELECT parent_token FROM students WHERE id = ?').get(studentId);
  if (s) {
    pushToStudent(studentId, { title: urgent ? '⚠️ Servis' : 'Servis', body: text, url: `/v/${s.parent_token}`, tag: urgent ? undefined : `servis-${kind}` })
      .catch((e) => console.warn('[push]', e.message));
  }
}

// --- Sefer --------------------------------------------------------------

/** type: 'morning' (evlerden okula) | 'afternoon' (okuldan evlere) */
export async function startTrip(busId, type) {
  if (!['morning', 'afternoon'].includes(type)) throw new HttpError(400, 'Geçersiz sefer tipi');
  const bus = db.prepare('SELECT * FROM buses WHERE id = ?').get(busId);
  if (!bus) throw new HttpError(404, 'Servis bulunamadı');
  const school = bus.school_id && db.prepare('SELECT * FROM schools WHERE id = ?').get(bus.school_id);
  if (!school) throw new HttpError(400, 'Bu servise okul atanmamış');

  const date = today();
  const all = db.prepare('SELECT * FROM students WHERE bus_id = ? ORDER BY stop_order, id').all(busId);
  const riding = all.filter((s) => s.lat != null && s.lng != null && s.absent_on !== date);

  const studentStops = riding.map((s) => ({
    kind: 'student', studentId: s.id, name: s.name, lat: s.lat, lng: s.lng, notifyMin: s.notify_min ?? 5,
  }));
  const schoolStop = { kind: 'school', name: school.name, lat: school.lat, lng: school.lng };
  // Akşam: okuldan çıkar, sabahki sıranın tersiyle bırakır
  const stops = type === 'morning' ? [...studentStops, schoolStop] : studentStops.reverse();
  if (studentStops.length === 0) throw new HttpError(400, 'Bu seferde öğrenci yok');
  for (const s of stops) Object.assign(s, { done: false, doneAt: null, nearNotified: false });

  // Yoklama listesi: servisin tüm öğrencileri (veli "gelmeyecek" dediyse işaretli)
  const riders = new Map(all.map((s) => [s.id, {
    studentId: s.id, name: s.name, order: s.stop_order,
    parentAbsent: s.absent_on === date, noLocation: s.lat == null,
    boardedAt: null, absentAt: null, droppedAt: null,
  }]));

  const st = busState(busId);
  if (st.trip && !st.trip.closedAt) {
    const onBoard = stillOnBoard(st.trip);
    if (onBoard.length) throw new HttpError(409, `Önceki turda inişi işaretlenmemiş öğrenci var: ${onBoard.map((r) => r.name).join(', ')}`);
  }
  if (type === 'afternoon' && !st.pos) st.pos = { lat: school.lat, lng: school.lng, at: Date.now() };

  st.trip = {
    type, date, busId, companyId: bus.company_id, stops, riders, removedStops: new Map(),
    startedAt: Date.now(), finishedAt: null, closedAt: null, route: null, progress: { idx: 0, dur: 0 },
  };
  await replan(busId);

  const text = type === 'morning' ? 'Servis yola çıktı.' : 'Servis okuldan yola çıkmak üzere.';
  for (const s of studentStops) notify(s.studentId, text, 'start');
  events.emit('update', busId);
  return st.trip;
}

/** Araçta inişi işaretlenmemiş öğrenciler (çocuk unutma kontrolü) */
function stillOnBoard(trip) {
  return [...trip.riders.values()].filter((r) => r.boardedAt && !r.droppedAt);
}

/** Turu kapatır. Araçta inişi işaretlenmemiş öğrenci varsa force olmadan kapatmaz. */
export function endTrip(busId, { force = false } = {}) {
  const trip = busState(busId).trip;
  if (!trip) return;
  const onBoard = stillOnBoard(trip);
  if (onBoard.length && !force) {
    throw new HttpError(409, `İnişi işaretlenmemiş öğrenci var: ${onBoard.map((r) => r.name).join(', ')}. Aracı kontrol edin!`,
      { onBoard: onBoard.map((r) => r.name) });
  }
  if (!trip.finishedAt) trip.finishedAt = Date.now();
  trip.closedAt = Date.now();
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

function markDone(trip, stop) {
  stop.done = true;
  stop.doneAt = Date.now();
  if (stop.kind === 'student') {
    notify(stop.studentId, trip.type === 'morning' ? 'Servis evinize ulaştı.' : 'Servis evinize ulaştı.', 'arrived');
  } else {
    for (const r of trip.riders.values()) {
      if (r.boardedAt && !r.droppedAt) notify(r.studentId, `Servis okula ulaştı (${stop.name}).`, 'school');
    }
  }
  if (trip.stops.every((s) => s.done)) trip.finishedAt = Date.now();
}

// --- Yoklama -------------------------------------------------------------

function record(trip, studentId, event) {
  db.prepare(`INSERT INTO attendance (company_id, bus_id, student_id, date, trip_type, event, at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(trip.companyId, trip.busId, studentId, trip.date, trip.type, event, Date.now());
}

/**
 * Şoförün yoklaması. event: 'boarded' (bindi) | 'absent' (binmedi) | 'dropped' (indi) | 'undo' (geri al)
 */
export async function markAttendance(busId, studentId, event) {
  const st = busState(busId);
  const trip = st.trip;
  if (!trip || trip.closedAt) throw new HttpError(400, 'Aktif tur yok');
  const r = trip.riders.get(studentId);
  if (!r) throw new HttpError(404, 'Öğrenci bu serviste değil');
  const now = Date.now();
  const morning = trip.type === 'morning';
  const stop = trip.stops.find((s) => s.studentId === studentId);

  switch (event) {
    case 'boarded':
      if (r.boardedAt) return;
      r.boardedAt = now; r.absentAt = null;
      record(trip, studentId, 'boarded');
      notify(studentId, morning ? `${r.name} servise bindi (${hhmm(now)}).` : `${r.name} okul çıkışı servise bindi (${hhmm(now)}).`, 'boarded');
      if (morning && stop && !stop.done) { stop.done = true; stop.doneAt = now; }
      if (!morning && trip.removedStops.has(studentId)) await restoreStop(trip, studentId);
      break;

    case 'absent':
      if (r.boardedAt) throw new HttpError(400, 'Önce "bindi" kaydını geri alın');
      if (r.absentAt) return;
      r.absentAt = now;
      record(trip, studentId, 'absent');
      if (morning) {
        notify(studentId, `${r.name} bugün servise binmedi.`, 'absent');
        if (stop && !stop.done) { stop.done = true; stop.doneAt = now; }
      } else {
        // Okul çıkışında binmeyen çocuk: veliye acil bildirim, evine uğranmaz
        notify(studentId, `${r.name} okul çıkışında servise BİNMEDİ! Lütfen okulla iletişime geçin.`, 'absent', { urgent: true });
        if (stop && !stop.done) {
          trip.stops.splice(trip.stops.indexOf(stop), 1);
          trip.removedStops.set(studentId, stop);
          await replan(busId);
        }
      }
      break;

    case 'dropped':
      if (!r.boardedAt) throw new HttpError(400, `${r.name} için biniş kaydı yok`);
      if (r.droppedAt) return;
      r.droppedAt = now;
      record(trip, studentId, 'dropped');
      notify(studentId, morning ? `${r.name} okulda servisten indi (${hhmm(now)}).` : `${r.name} evde servisten indi (${hhmm(now)}).`, 'dropped');
      if (!morning && stop && !stop.done) { stop.done = true; stop.doneAt = now; }
      break;

    case 'undo': {
      // Yanlış dokunuşu geri al: bu turun bu öğrenci için son kaydını sil
      const last = db.prepare(`SELECT * FROM attendance WHERE student_id = ? AND date = ? AND trip_type = ? ORDER BY id DESC LIMIT 1`)
        .get(studentId, trip.date, trip.type);
      if (!last) return;
      db.prepare('DELETE FROM attendance WHERE id = ?').run(last.id);
      if (last.event === 'dropped') r.droppedAt = null;
      if (last.event === 'boarded') { r.boardedAt = null; if (morning && stop) stop.done = false; }
      if (last.event === 'absent') {
        r.absentAt = null;
        if (morning && stop) stop.done = false;
        if (!morning && trip.removedStops.has(studentId)) await restoreStop(trip, studentId);
      }
      notify(studentId, 'Şoför son yoklama kaydını düzeltti.', 'undo');
      break;
    }
    default:
      throw new HttpError(400, 'Geçersiz yoklama');
  }
  if (trip.stops.every((s) => s.done) && !trip.finishedAt) trip.finishedAt = now;
  events.emit('update', busId);
}

/** Sabah okulda: binen herkes indi */
export async function dropAllAtSchool(busId) {
  const trip = busState(busId).trip;
  if (!trip || trip.type !== 'morning') throw new HttpError(400, 'Sabah turu yok');
  for (const r of stillOnBoard(trip)) await markAttendance(busId, r.studentId, 'dropped');
  const school = trip.stops.find((s) => s.kind === 'school');
  if (school && !school.done) markDone(trip, school);
  events.emit('update', busId);
}

/** Akşam okulda: listede olup veli "gelmeyecek" demeyen herkes bindi */
export async function boardAllAtSchool(busId) {
  const trip = busState(busId).trip;
  if (!trip || trip.type !== 'afternoon') throw new HttpError(400, 'Akşam turu yok');
  for (const r of trip.riders.values()) {
    if (!r.parentAbsent && !r.noLocation && !r.boardedAt && !r.absentAt) await markAttendance(busId, r.studentId, 'boarded');
  }
}

async function restoreStop(trip, studentId) {
  const stop = trip.removedStops.get(studentId);
  trip.removedStops.delete(studentId);
  stop.done = false;
  // Sıraya göre doğru yere geri koy
  const order = (id) => trip.riders.get(id)?.order ?? 0;
  const idx = trip.stops.findIndex((s) => s.kind === 'student' && !s.done && order(s.studentId) < order(studentId));
  if (idx < 0) trip.stops.push(stop); else trip.stops.splice(idx, 0, stop);
  await replan(trip.busId);
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
      markDone(trip, next);
    }

    // "X dk kaldı" bildirimleri (her veli kendi süresini seçer)
    for (const e of computeEtas(trip)) {
      const s = e.stop;
      if (s.kind === 'student' && !s.nearNotified && s.notifyMin > 0 && e.etaSec <= s.notifyMin * 60) {
        s.nearNotified = true;
        const min = Math.max(1, Math.round(e.etaSec / 60));
        notify(s.studentId, `Servis yaklaşık ${min} dakika sonra evinizde.`, 'near');
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

// --- Veli ayarları -------------------------------------------------------

export async function setAbsent(studentId, absent) {
  db.prepare('UPDATE students SET absent_on = ? WHERE id = ?').run(absent ? today() : null, studentId);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if (!student?.bus_id) return;
  const trip = busState(student.bus_id).trip;
  if (!trip || trip.finishedAt) return;
  const r = trip.riders.get(studentId);
  if (r) r.parentAbsent = absent;
  if (absent) {
    const i = trip.stops.findIndex((s) => s.studentId === studentId && !s.done);
    if (i >= 0 && !r?.boardedAt) {
      trip.stops.splice(i, 1);
      await replan(student.bus_id); // diğer velilerin süresi kısalır
    }
  }
  events.emit('update', student.bus_id);
}

export function setNotifyMin(studentId, min) {
  const m = Math.max(0, Math.min(30, Math.round(Number(min) || 0)));
  db.prepare('UPDATE students SET notify_min = ? WHERE id = ?').run(m, studentId);
  for (const st of state.values()) {
    const stop = st.trip?.stops.find((s) => s.studentId === studentId);
    if (stop) stop.notifyMin = m;
  }
}

// --- Görünümler ----------------------------------------------------------

const isStale = (pos) => !pos || Date.now() - pos.at > STALE_MS;

function todayAttendance(studentId) {
  const rows = db.prepare('SELECT trip_type, event, at FROM attendance WHERE student_id = ? AND date = ? ORDER BY id').all(studentId, today());
  const out = { morning: {}, afternoon: {} };
  for (const r of rows) out[r.trip_type][r.event] = r.at;
  return out;
}

export function attendanceHistory(studentId, days = 30) {
  const since = today(new Date(Date.now() - days * 86400_000));
  const rows = db.prepare('SELECT date, trip_type, event, at FROM attendance WHERE student_id = ? AND date >= ? ORDER BY date DESC, id')
    .all(studentId, since);
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, { date: r.date, morning: {}, afternoon: {} });
    byDate.get(r.date)[r.trip_type][r.event] = r.at;
  }
  return [...byDate.values()];
}

/** Veliye gösterilecek bilgi. Gizlilik: başka öğrencilerin adres/adı yok. */
export function parentView(student) {
  const bus = student.bus_id && db.prepare('SELECT * FROM buses WHERE id = ?').get(student.bus_id);
  const school = bus?.school_id && db.prepare('SELECT * FROM schools WHERE id = ?').get(bus.school_id);
  const st = bus ? busState(bus.id) : { pos: null, trip: null };
  // Dünden kalan tur gösterilmez
  const trip = st.trip?.date === today() ? st.trip : null;
  const etas = computeEtas(trip);

  let tripView = null;
  if (trip) {
    const my = trip.stops.find((s) => s.studentId === student.id);
    const myEta = etas.find((e) => e.stop === my);
    const schoolStop = trip.stops.find((s) => s.kind === 'school');
    const schoolEta = etas.find((e) => e.stop === schoolStop);
    const r = trip.riders.get(student.id);
    tripView = {
      type: trip.type,
      startedAt: trip.startedAt,
      finishedAt: trip.finishedAt,
      onTrip: !!my,
      myStop: my ? { done: my.done, doneAt: my.doneAt, etaSec: myEta?.etaSec ?? null, stopsBefore: myEta?.stopsBefore ?? 0 } : null,
      school: schoolStop ? { done: schoolStop.done, doneAt: schoolStop.doneAt, etaSec: schoolEta?.etaSec ?? null } : null,
      me: r ? { boardedAt: r.boardedAt, absentAt: r.absentAt, droppedAt: r.droppedAt } : null,
    };
  }

  const active = trip && !trip.finishedAt;
  return {
    student: {
      name: student.name,
      home: student.lat != null ? { lat: student.lat, lng: student.lng } : null,
      absentToday: student.absent_on === today(),
      notifyMin: student.notify_min,
    },
    bus: bus ? { name: bus.name, plate: bus.plate, driverName: bus.driver_name, driverPhone: bus.driver_phone } : null,
    school: school ? { name: school.name, lat: school.lat, lng: school.lng } : null,
    trip: tripView,
    attendance: todayAttendance(student.id),
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
      date: trip.date,
      startedAt: trip.startedAt,
      finishedAt: trip.finishedAt,
      closedAt: trip.closedAt,
      routeSource: trip.route?.source,
      stops: trip.stops.map((s) => {
        const e = etas.find((x) => x.stop === s);
        return { kind: s.kind, studentId: s.studentId, name: s.name, lat: s.lat, lng: s.lng, done: s.done, doneAt: s.doneAt, etaSec: e?.etaSec ?? null };
      }),
      riders: [...trip.riders.values()].sort((a, b) => a.order - b.order),
      onBoard: stillOnBoard(trip).map((r) => r.name),
    },
  };
}

export function getTrip(busId) {
  return busState(busId).trip;
}

export function forgetBus(busId) {
  state.delete(busId);
}
