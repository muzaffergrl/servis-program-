// Demo / test için sahte servis: rotayı takip ederek konum gönderir ve şoför yerine yoklama yapar.
// Mevcut takip programının API'si bağlandığında konum kısmına gerek kalmayacak.
import { db } from './db.js';
import {
  startTrip, endTrip, updatePosition, getTrip, markAttendance, dropAllAtSchool, boardAllAtSchool, HttpError,
} from './tracker.js';
import { pointAt } from './routing.js';

const SPEEDUP = Number(process.env.SIM_SPEEDUP || 8); // gerçek zamandan kaç kat hızlı
const DWELL = Number(process.env.STOP_DWELL_SEC || 45);
const running = new Map(); // busId -> interval

export function isSimulating(busId) {
  return running.has(busId);
}

export function stopSimulation(busId) {
  clearInterval(running.get(busId));
  running.delete(busId);
}

export async function simulate(busId, type) {
  stopSimulation(busId);
  const bus = db.prepare('SELECT * FROM buses WHERE id = ?').get(busId);
  if (!bus) throw new HttpError(404, 'Servis bulunamadı');
  if (getTrip(busId)) endTrip(busId, { force: true });

  if (type === 'morning') {
    // Servisi ilk öğrencinin ~1 km uzağından başlat
    const first = db.prepare(`SELECT lat, lng FROM students WHERE bus_id = ? AND lat IS NOT NULL ORDER BY stop_order, id LIMIT 1`).get(busId);
    if (first) await updatePosition(busId, first.lat + 0.006, first.lng - 0.006);
  } else {
    const school = db.prepare('SELECT lat, lng FROM schools WHERE id = ?').get(bus.school_id);
    if (school) await updatePosition(busId, school.lat, school.lng);
  }
  await startTrip(busId, type);
  if (type === 'afternoon') await boardAllAtSchool(busId);

  let route = null;
  let t = 0;
  let pause = 0;
  let pending = [];
  let busy = false;
  const handled = new Set();

  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const trip = getTrip(busId);
      if (!trip || trip.closedAt) return stopSimulation(busId);

      // Şoförün yapacağı yoklamayı taklit et
      for (const s of trip.stops) {
        if (!s.done || handled.has(s)) continue;
        handled.add(s);
        if (s.kind === 'school') await dropAllAtSchool(busId);
        else if (type === 'morning') {
          // Demo için: ara sıra bir öğrenci binmez
          await markAttendance(busId, s.studentId, Math.random() < 0.1 ? 'absent' : 'boarded');
        } else await markAttendance(busId, s.studentId, 'dropped');
      }
      if (trip.finishedAt) { endTrip(busId, { force: true }); return stopSimulation(busId); }

      if (trip.route !== route) {
        // Rota yeniden hesaplandıysa baştan takip et
        route = trip.route;
        t = 0;
        pending = trip.stops.filter((s) => !s.done).map((s) => s.routeDur).sort((a, b) => a - b);
      }
      let budget = SPEEDUP;
      while (budget > 0) {
        if (pause > 0) {
          const use = Math.min(pause, budget);
          pause -= use; budget -= use;
          continue;
        }
        const nextStop = pending[0] ?? route.cumDur.at(-1);
        const move = Math.min(budget, Math.max(0, nextStop - t));
        t += move; budget -= move;
        if (pending.length && t >= pending[0]) { pending.shift(); pause = DWELL; }
        else if (move === 0) break; // rota sonu
      }
      const [lat, lng] = pointAt(route, t);
      await updatePosition(busId, lat, lng, { speed: pause > 0 ? 0 : 8 });
    } catch (e) {
      console.error('[simülatör]', e.message);
      stopSimulation(busId);
    } finally {
      busy = false;
    }
  }, 1000);
  running.set(busId, timer);
}
