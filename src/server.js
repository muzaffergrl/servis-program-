import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { db, newToken } from './db.js';
import {
  events, startTrip, endTrip, updatePosition, setAbsent, parentView, busView, forgetBus, HttpError,
} from './tracker.js';
import { simulate, stopSimulation, isSimulating } from './simulator.js';
import { startExternalProvider } from './providers/external-api.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
if (!process.env.ADMIN_PASSWORD) console.warn('UYARI: ADMIN_PASSWORD ayarlanmamış, varsayılan şifre "admin" kullanılıyor!');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '100kb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Sayfalar ------------------------------------------------------------
const page = (name) => (req, res) => res.sendFile(path.join(root, 'public', name));
app.use('/static', express.static(path.join(root, 'public')));
app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules', 'leaflet', 'dist')));
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/v/:token', page('parent.html'));
app.get('/d/:token', page('driver.html'));

app.get('/api/config', (req, res) => res.json({
  tileUrl: process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: process.env.TILE_ATTRIBUTION || '&copy; OpenStreetMap katkıcıları',
}));

// SSE (canlı güncelleme) yardımcısı
function sse(req, res, onEvent) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const cleanup = onEvent(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); cleanup(); });
}

/** Sık gelen güncellemeleri saniyede bire indirger */
function throttled(fn, ms = 1000) {
  let timer = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  };
}

// --- Veli ----------------------------------------------------------------
function studentByToken(token) {
  const s = db.prepare('SELECT * FROM students WHERE parent_token = ?').get(token);
  if (!s) throw new HttpError(404, 'Bağlantı geçersiz');
  return s;
}

app.get('/api/parent/:token', (req, res) => res.json(parentView(studentByToken(req.params.token))));

app.get('/api/parent/:token/stream', (req, res) => {
  const student = studentByToken(req.params.token);
  sse(req, res, (send) => {
    const push = () => {
      try { send('view', parentView(studentByToken(req.params.token))); } catch { res.end(); }
    };
    const onUpdate = throttled(push);
    const busHandler = (busId) => { if (busId === student.bus_id) onUpdate(); };
    const notifyHandler = (n) => { if (n.studentId === student.id) send('notify', n); };
    events.on('update', busHandler);
    events.on('notify', notifyHandler);
    push();
    return () => { events.off('update', busHandler); events.off('notify', notifyHandler); };
  });
});

app.post('/api/parent/:token/absent', wrap(async (req, res) => {
  const s = studentByToken(req.params.token);
  await setAbsent(s.id, !!req.body.absent);
  res.json(parentView(studentByToken(req.params.token)));
}));

// --- Şoför ---------------------------------------------------------------
function busByToken(token) {
  const b = db.prepare('SELECT * FROM buses WHERE driver_token = ?').get(token);
  if (!b) throw new HttpError(404, 'Bağlantı geçersiz');
  return b;
}
const driverView = (b) => ({ bus: { id: b.id, name: b.name, plate: b.plate }, ...busView(b.id) });

app.get('/api/driver/:token', (req, res) => res.json(driverView(busByToken(req.params.token))));
app.post('/api/driver/:token/location', wrap(async (req, res) => {
  const b = busByToken(req.params.token);
  const { lat, lng, speed, accuracy } = req.body;
  if (accuracy > 200) return res.json({ ignored: 'Konum hassasiyeti düşük' });
  await updatePosition(b.id, Number(lat), Number(lng), { speed, accuracy });
  res.json(driverView(b));
}));
app.post('/api/driver/:token/trip', wrap(async (req, res) => {
  const b = busByToken(req.params.token);
  await startTrip(b.id, req.body.type);
  res.json(driverView(b));
}));
app.delete('/api/driver/:token/trip', (req, res) => {
  const b = busByToken(req.params.token);
  endTrip(b.id);
  res.json(driverView(b));
});

// --- Yönetici ------------------------------------------------------------
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
function adminAuth(req, res, next) {
  const [type, value] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && value) {
    const [user, ...rest] = Buffer.from(value, 'base64').toString().split(':');
    if (safeEqual(user, ADMIN_USER) && safeEqual(rest.join(':'), ADMIN_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Servis Takip Yonetim", charset="UTF-8"').status(401).send('Giriş gerekli');
}
app.use(['/admin', '/api/admin'], adminAuth);
app.get('/admin', page('admin.html'));

function adminState() {
  const buses = db.prepare('SELECT * FROM buses ORDER BY name').all()
    .map((b) => ({ ...b, live: busView(b.id), simulating: isSimulating(b.id) }));
  return {
    schools: db.prepare('SELECT * FROM schools ORDER BY name').all(),
    buses,
    students: db.prepare('SELECT * FROM students ORDER BY bus_id, stop_order, id').all(),
  };
}
app.get('/api/admin/state', (req, res) => res.json(adminState()));
app.get('/api/admin/stream', (req, res) => {
  sse(req, res, (send) => {
    const onUpdate = throttled(() => send('state', adminState()));
    events.on('update', onUpdate);
    return () => events.off('update', onUpdate);
  });
});

const num = (v) => (v === '' || v == null ? null : Number(v));
const str = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
function required(v, label) {
  if (v == null || v === '' || Number.isNaN(v)) throw new HttpError(400, `${label} gerekli`);
  return v;
}

// Okullar
app.post('/api/admin/schools', (req, res) => {
  const b = req.body;
  const r = db.prepare('INSERT INTO schools (name, lat, lng) VALUES (?, ?, ?)')
    .run(required(str(b.name), 'Okul adı'), required(num(b.lat), 'Konum'), required(num(b.lng), 'Konum'));
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/admin/schools/:id', (req, res) => {
  const b = req.body;
  db.prepare('UPDATE schools SET name = ?, lat = ?, lng = ? WHERE id = ?')
    .run(required(str(b.name), 'Okul adı'), required(num(b.lat), 'Konum'), required(num(b.lng), 'Konum'), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/schools/:id', (req, res) => {
  db.prepare('DELETE FROM schools WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Servisler
app.post('/api/admin/buses', (req, res) => {
  const b = req.body;
  const r = db.prepare(`INSERT INTO buses (name, plate, driver_name, driver_phone, school_id, external_id, driver_token)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(required(str(b.name), 'Servis adı'), str(b.plate), str(b.driver_name), str(b.driver_phone), num(b.school_id), str(b.external_id), newToken());
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/admin/buses/:id', (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE buses SET name = ?, plate = ?, driver_name = ?, driver_phone = ?, school_id = ?, external_id = ? WHERE id = ?`)
    .run(required(str(b.name), 'Servis adı'), str(b.plate), str(b.driver_name), str(b.driver_phone), num(b.school_id), str(b.external_id), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/buses/:id', (req, res) => {
  const id = Number(req.params.id);
  stopSimulation(id);
  forgetBus(id);
  db.prepare('DELETE FROM buses WHERE id = ?').run(id);
  res.json({ ok: true });
});
app.post('/api/admin/buses/:id/trip', wrap(async (req, res) => {
  await startTrip(Number(req.params.id), req.body.type);
  res.json({ ok: true });
}));
app.delete('/api/admin/buses/:id/trip', (req, res) => {
  stopSimulation(Number(req.params.id));
  endTrip(Number(req.params.id));
  res.json({ ok: true });
});
app.post('/api/admin/buses/:id/simulate', wrap(async (req, res) => {
  await simulate(Number(req.params.id), req.body.type);
  res.json({ ok: true });
}));

// Öğrenciler
app.post('/api/admin/students', (req, res) => {
  const b = req.body;
  const r = db.prepare(`INSERT INTO students (name, bus_id, address, lat, lng, stop_order, parent_name, parent_phone, parent_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(required(str(b.name), 'Öğrenci adı'), num(b.bus_id), str(b.address), num(b.lat), num(b.lng), num(b.stop_order) ?? 0,
      str(b.parent_name), str(b.parent_phone), newToken());
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/admin/students/:id', (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE students SET name = ?, bus_id = ?, address = ?, lat = ?, lng = ?, stop_order = ?, parent_name = ?, parent_phone = ? WHERE id = ?`)
    .run(required(str(b.name), 'Öğrenci adı'), num(b.bus_id), str(b.address), num(b.lat), num(b.lng), num(b.stop_order) ?? 0,
      str(b.parent_name), str(b.parent_phone), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/students/:id', (req, res) => {
  db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
// Link sızarsa yenilemek için
app.post('/api/admin/students/:id/new-link', (req, res) => {
  db.prepare('UPDATE students SET parent_token = ? WHERE id = ?').run(newToken(), req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/buses/:id/new-link', (req, res) => {
  db.prepare('UPDATE buses SET driver_token = ? WHERE id = ?').run(newToken(), req.params.id);
  res.json({ ok: true });
});

// --- Hatalar -------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Bulunamadı' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Sunucu hatası' : err.message });
});

app.listen(PORT, () => {
  console.log(`Servis takip çalışıyor: http://localhost:${PORT}/admin`);
  startExternalProvider();
});
