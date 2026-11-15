// Çalıştırma: npm test  (internet gerektirmez, basit süre tahmini kullanır)
process.env.DB_FILE = ':memory:';
process.env.ROUTING = 'simple';
process.env.PUSH_DISABLED = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db, newToken } = await import('../src/db.js');
const tracker = await import('../src/tracker.js');
const { planRoute, projectOnRoute, pointAt } = await import('../src/routing.js');

const company = Number(db.prepare('INSERT INTO companies (name) VALUES (?)').run('Firma').lastInsertRowid);
const school = Number(db.prepare('INSERT INTO schools (company_id, name, lat, lng) VALUES (?, ?, ?, ?)').run(company, 'Okul', 41.0255, 29.096).lastInsertRowid);
const bus = Number(db.prepare('INSERT INTO buses (company_id, name, school_id, driver_token) VALUES (?, ?, ?, ?)').run(company, 'S1', school, newToken()).lastInsertRowid);
const addStudent = (name, lat, lng, order) => Number(db.prepare(
  'INSERT INTO students (company_id, name, bus_id, lat, lng, stop_order, parent_token) VALUES (?, ?, ?, ?, ?, ?, ?)',
).run(company, name, bus, lat, lng, order, newToken()).lastInsertRowid);
const a = addStudent('A', 41.041, 29.079, 1);
const b = addStudent('B', 41.0352, 29.0861, 2);
const c = addStudent('C', 41.029, 29.0915, 3);
const student = (id) => db.prepare('SELECT * FROM students WHERE id = ?').get(id);
const view = (id) => tracker.parentView(student(id));

test('rota üzerine izdüşürme', async () => {
  const r = await planRoute([[41.0, 29.0], [41.01, 29.0], [41.01, 29.01]]);
  const mid = pointAt(r, r.cumDur[1] / 2);
  const p = projectOnRoute(r, mid, 0);
  assert.ok(p.dist < 1);
  assert.ok(Math.abs(p.dur - r.cumDur[1] / 2) < 1);
});

test('sabah turu: süreler, yoklama, okulda iniş, çocuk unutma kontrolü', async () => {
  await tracker.updatePosition(bus, 41.047, 29.073);
  await tracker.startTrip(bus, 'morning');

  const v0 = view(c);
  assert.equal(v0.trip.myStop.stopsBefore, 2);
  assert.ok(v0.trip.myStop.etaSec > 0);
  assert.ok(v0.busPos);

  // A'nın evine var, şoför "bindi" der
  await tracker.updatePosition(bus, 41.041, 29.079);
  await tracker.markAttendance(bus, a, 'boarded');
  assert.ok(view(a).messages.some((m) => m.kind === 'boarded'));
  assert.ok(view(a).attendance.morning.boarded);

  const v1 = view(c);
  assert.equal(v1.trip.myStop.stopsBefore, 1);
  assert.ok(v1.trip.myStop.etaSec < v0.trip.myStop.etaSec);

  // B gelmeyecek (veli) -> C'nin önünde kimse kalmaz
  await tracker.setAbsent(b, true);
  const v2 = view(c);
  assert.equal(v2.trip.myStop.stopsBefore, 0);
  assert.ok(v2.trip.myStop.etaSec < v1.trip.myStop.etaSec);

  // C'ye yaklaş: "X dk kaldı" bildirimi
  await tracker.updatePosition(bus, 41.030, 29.0905);
  assert.ok(view(c).messages.some((m) => m.kind === 'near'));

  // Şoför yanlışlıkla "binmedi" der, geri alır, "bindi" der
  await tracker.markAttendance(bus, c, 'absent');
  await tracker.markAttendance(bus, c, 'undo');
  assert.equal(view(c).attendance.morning.absent, undefined);
  await tracker.markAttendance(bus, c, 'boarded');

  await tracker.updatePosition(bus, 41.0255, 29.096);
  const done = view(a);
  assert.ok(done.trip.finishedAt);
  assert.equal(done.busPos, null, 'tur bitince konum gizlenmeli');

  // Okulda iniş işaretlenmeden tur kapatılamaz
  assert.throws(() => tracker.endTrip(bus), (e) => e.status === 409 && /A, C/.test(e.message));
  await tracker.dropAllAtSchool(bus);
  assert.ok(view(a).attendance.morning.dropped);
  assert.ok(view(c).attendance.morning.dropped);
  tracker.endTrip(bus);
  await tracker.setAbsent(b, false);
});

test('akşam turu: ters sıra, binmeyen çocuk için acil bildirim', async () => {
  await tracker.startTrip(bus, 'afternoon');
  assert.deepEqual(tracker.busView(bus).trip.stops.map((s) => s.name), ['C', 'B', 'A']);

  await tracker.markAttendance(bus, c, 'boarded');
  await tracker.markAttendance(bus, a, 'boarded');
  await tracker.markAttendance(bus, b, 'absent');
  const vb = view(b);
  assert.ok(vb.messages.some((m) => m.urgent && /BİNMEDİ/.test(m.text)));
  // B'nin evine uğranmaz
  assert.deepEqual(tracker.busView(bus).trip.stops.map((s) => s.name), ['C', 'A']);

  // Geri alınca durak geri gelir
  await tracker.markAttendance(bus, b, 'undo');
  assert.deepEqual(tracker.busView(bus).trip.stops.map((s) => s.name), ['C', 'B', 'A']);
  await tracker.markAttendance(bus, b, 'absent');

  // İnmeden "indi" yazılamaz / binmeden inemez
  await assert.rejects(() => tracker.markAttendance(bus, b, 'dropped'));

  await tracker.markAttendance(bus, c, 'dropped');
  assert.ok(view(c).attendance.afternoon.dropped);
  // A hâlâ araçta: yeni tur başlatılamaz
  await assert.rejects(() => tracker.startTrip(bus, 'morning'), (e) => e.status === 409);
  await tracker.markAttendance(bus, a, 'dropped');
  tracker.endTrip(bus);

  const hist = tracker.attendanceHistory(a);
  assert.equal(hist.length, 1);
  assert.ok(hist[0].morning.boarded && hist[0].afternoon.dropped);
});

test('veli görünümünde başka öğrencinin bilgisi yok', async () => {
  await tracker.startTrip(bus, 'morning');
  const json = JSON.stringify(view(c));
  assert.ok(!json.includes('"A"') && !json.includes('"B"'));
  assert.ok(!json.includes('41.041'));
  tracker.endTrip(bus, { force: true });
});

test('veli bildirim süresini kendisi seçer', async () => {
  tracker.setNotifyMin(a, 10);
  assert.equal(student(a).notify_min, 10);
  tracker.setNotifyMin(a, 999);
  assert.equal(student(a).notify_min, 30);
});
