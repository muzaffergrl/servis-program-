// Sunucu yeniden başlarsa devam eden tur kaybolmamalı; geçmiş kayıtlardan "genelde" saati öğrenilmeli.
process.env.DB_FILE = ':memory:';
process.env.PUSH_DISABLED = '1';
process.env.ROUTING = 'simple';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db, newToken, today } = await import('../src/db.js');
const tracker = await import('../src/tracker.js');

function setup() {
  const c = Number(db.prepare('INSERT INTO companies (name) VALUES (?)').run('F').lastInsertRowid);
  const sc = Number(db.prepare('INSERT INTO schools (company_id, name, lat, lng) VALUES (?, ?, ?, ?)').run(c, 'Okul', 41.0255, 29.096).lastInsertRowid);
  const bus = Number(db.prepare('INSERT INTO buses (company_id, name, school_id, driver_token) VALUES (?, ?, ?, ?)').run(c, 'S', sc, newToken()).lastInsertRowid);
  const ins = db.prepare('INSERT INTO students (company_id, name, bus_id, lat, lng, stop_order, parent_token) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const a = Number(ins.run(c, 'A', bus, 41.04, 29.08, 1, newToken()).lastInsertRowid);
  const b = Number(ins.run(c, 'B', bus, 41.035, 29.086, 2, newToken()).lastInsertRowid);
  return { c, bus, a, b };
}

test('yeniden başlatmada tur, yoklama ve bildirimler korunur', async () => {
  const { bus, a, b } = setup();
  await tracker.updatePosition(bus, 41.05, 29.07);
  await tracker.startTrip(bus, 'morning');
  await tracker.markAttendance(bus, a, 'boarded');
  tracker.saveBus(bus);

  // "Sunucu yeniden başladı": bellek silinip veritabanından yüklenir
  assert.ok(tracker.loadState() >= 1);
  const v = tracker.busView(bus);
  assert.equal(v.trip.type, 'morning');
  assert.ok(v.trip.riders.find((r) => r.studentId === a).boardedAt);
  assert.ok(v.trip.stops.some((s) => s.studentId === b && !s.done));
  assert.ok(v.pos);

  // Kaldığı yerden devam eder: yoklama ve konum çalışır
  await tracker.markAttendance(bus, b, 'boarded');
  await tracker.updatePosition(bus, 41.03, 29.09);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(a);
  const pv = tracker.parentView(student);
  assert.ok(pv.messages.some((m) => /bindi/.test(m.text)), 'bildirim geçmişi de korunmalı');
  await tracker.dropAllAtSchool(bus);
  tracker.endTrip(bus);
});

test('dünden kalan tur yüklenmez', () => {
  const { bus } = setup();
  const trip = { type: 'morning', date: '2020-01-01', busId: bus, stops: [], riders: [], removedStops: [] };
  db.prepare('INSERT INTO live_state (bus_id, data, updated_at) VALUES (?, ?, ?)').run(bus, JSON.stringify({ pos: null, trip }), Date.now());
  tracker.loadState();
  assert.equal(tracker.busView(bus).trip, null);
});

test('geçmiş biniş saatlerinden "genelde" saati öğrenilir', () => {
  const { c, bus, a } = setup();
  assert.equal(tracker.usualTime(a, 'morning'), null, 'kayıt yokken tahmin yok');
  const att = db.prepare(`INSERT INTO attendance (company_id, bus_id, student_id, date, trip_type, event, at) VALUES (?, ?, ?, ?, 'morning', 'boarded', ?)`);
  [[1, 40], [2, 42], [3, 44], [4, 42]].forEach(([d, m]) => {
    const date = today(new Date(Date.now() - d * 86400_000));
    att.run(c, bus, a, date, new Date(`${date}T07:${m}:00+03:00`).getTime());
  });
  assert.deepEqual(tracker.usualTime(a, 'morning'), { time: '07:42', days: 4 });
});
