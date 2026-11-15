// Çalıştırma: npm test  (internet gerektirmez, basit süre tahmini kullanır)
process.env.DB_FILE = ':memory:';
process.env.ROUTING = 'simple';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db, newToken } = await import('../src/db.js');
const tracker = await import('../src/tracker.js');
const { planRoute, projectOnRoute, pointAt } = await import('../src/routing.js');

const school = Number(db.prepare('INSERT INTO schools (name, lat, lng) VALUES (?, ?, ?)').run('Okul', 41.0255, 29.096).lastInsertRowid);
const bus = Number(db.prepare('INSERT INTO buses (name, school_id, driver_token) VALUES (?, ?, ?)').run('S1', school, newToken()).lastInsertRowid);
const addStudent = (name, lat, lng, order) => Number(db.prepare(
  'INSERT INTO students (name, bus_id, lat, lng, stop_order, parent_token) VALUES (?, ?, ?, ?, ?, ?)',
).run(name, bus, lat, lng, order, newToken()).lastInsertRowid);
const a = addStudent('A', 41.041, 29.079, 1);
const b = addStudent('B', 41.0352, 29.0861, 2);
const c = addStudent('C', 41.029, 29.0915, 3);
const student = (id) => db.prepare('SELECT * FROM students WHERE id = ?').get(id);

test('rota üzerine izdüşürme', async () => {
  const r = await planRoute([[41.0, 29.0], [41.01, 29.0], [41.01, 29.01]]);
  const mid = pointAt(r, r.cumDur[1] / 2);
  const p = projectOnRoute(r, mid, 0);
  assert.ok(p.dist < 1);
  assert.ok(Math.abs(p.dur - r.cumDur[1] / 2) < 1);
});

test('sabah turu: süreler azalır, duraklar ve bildirimler işler', async () => {
  await tracker.updatePosition(bus, 41.047, 29.073);
  await tracker.startTrip(bus, 'morning');

  const v0 = tracker.parentView(student(c));
  assert.equal(v0.trip.myStop.stopsBefore, 2);
  assert.ok(v0.trip.myStop.etaSec > 0);
  assert.ok(v0.busPos);

  // A'nın evine var
  await tracker.updatePosition(bus, 41.041, 29.079);
  const va = tracker.parentView(student(a));
  assert.equal(va.trip.myStop.done, true);
  assert.ok(va.messages.some((m) => m.kind === 'arrived'));

  const v1 = tracker.parentView(student(c));
  assert.equal(v1.trip.myStop.stopsBefore, 1);
  assert.ok(v1.trip.myStop.etaSec < v0.trip.myStop.etaSec);

  // B gelmeyecek -> C'nin önünde kimse kalmaz
  await tracker.setAbsent(b, true);
  const v2 = tracker.parentView(student(c));
  assert.equal(v2.trip.myStop.stopsBefore, 0);
  assert.ok(v2.trip.myStop.etaSec < v1.trip.myStop.etaSec);
  assert.equal(tracker.parentView(student(b)).student.absentToday, true);

  // C'ye yaklaş: "X dk kaldı" bildirimi
  await tracker.updatePosition(bus, 41.030, 29.0905);
  assert.ok(tracker.parentView(student(c)).messages.some((m) => m.kind === 'near'));

  await tracker.updatePosition(bus, 41.029, 29.0915);
  await tracker.updatePosition(bus, 41.0255, 29.096);
  const done = tracker.parentView(student(a));
  assert.ok(done.trip.finishedAt);
  assert.ok(done.trip.school.done);
  assert.equal(done.busPos, null, 'tur bitince konum gizlenmeli');
  assert.ok(done.messages.some((m) => m.kind === 'school'));
  await tracker.setAbsent(b, false);
});

test('akşam turu ters sırayla bırakır', async () => {
  await tracker.startTrip(bus, 'afternoon');
  const stops = tracker.busView(bus).trip.stops.map((s) => s.name);
  assert.deepEqual(stops, ['C', 'B', 'A']);
  tracker.endTrip(bus);
});

test('veli görünümünde başka öğrencinin bilgisi yok', async () => {
  await tracker.startTrip(bus, 'morning');
  const json = JSON.stringify(tracker.parentView(student(c)));
  assert.ok(!json.includes('"A"') && !json.includes('"B"'));
  assert.ok(!json.includes('41.041'));
  tracker.endTrip(bus);
});
