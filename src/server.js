import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, newToken, today, hashPassword, checkPassword, ensureSuperAdmin, DB_FILE } from './db.js';
import { mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import {
  events, startTrip, endTrip, updatePosition, setAbsent, setNotifyMin, parentView, busView, forgetBus,
  markAttendance, dropAllAtSchool, boardAllAtSchool, attendanceHistory, HttpError, announce, saveBus,
} from './tracker.js';
import { simulate, stopSimulation, isSimulating } from './simulator.js';
import { startExternalProvider } from './providers/external-api.js';
import { publicKey, saveSubscription, removeSubscription, hasSubscription } from './push.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = 30;

if (!process.env.ADMIN_PASSWORD) console.warn('UYARI: ADMIN_PASSWORD ayarlanmamış, süper yönetici şifresi "admin"!');
ensureSuperAdmin((process.env.ADMIN_USER || 'admin').toLowerCase(), process.env.ADMIN_PASSWORD || 'admin');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '100kb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Sayfalar ------------------------------------------------------------
const page = (name) => (req, res) => res.sendFile(path.join(root, 'public', name));
app.use('/static', express.static(path.join(root, 'public')));
app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules', 'leaflet', 'dist')));
// Service worker kök dizinden sunulmalı ki tüm sayfaları kapsasın
app.get('/sw.js', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(root, 'public', 'sw.js')); });
// DEMO_HUB=1 ise ana sayfa, demo firmasının tüm ekranlarına tek tıkla giden bir menü olur (canlıda kapalı)
app.get('/', (req, res) => {
  if (process.env.DEMO_HUB !== '1') return res.redirect('/admin');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const buses = db.prepare('SELECT b.id, b.name, b.driver_token FROM buses b JOIN companies c ON c.id = b.company_id WHERE c.name = ? ORDER BY b.id').all('Demo Servis');
  const studentsOf = db.prepare('SELECT name, parent_token FROM students WHERE bus_id = ? ORDER BY stop_order, id');
  const busHtml = buses.map((b) => `
    <div class="card"><h3>🚌 ${esc(b.name)}</h3>
      <a class="big" href="/d/${esc(b.driver_token)}">👨‍✈️ Şoför ekranı</a>
      <p class="muted small">Veli ekranları:</p>
      <div class="list">${studentsOf.all(b.id).map((s) => `<a href="/v/${esc(s.parent_token)}">👪 ${esc(s.name)}</a>`).join('')}</div>
    </div>`).join('');
  res.send(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Servis Takip – Demo</title><link rel="stylesheet" href="/static/style.css">
<style>body{padding:16px;max-width:720px;margin:0 auto}.card{margin-bottom:14px}a.big{display:block;padding:14px;border-radius:12px;background:var(--primary);color:var(--primary-ink);text-decoration:none;font-weight:600;text-align:center;margin:8px 0}
.list{display:grid;grid-template-columns:1fr 1fr;gap:8px}.list a{padding:10px;border:1px solid var(--line);border-radius:10px;text-decoration:none;color:inherit}
ol{padding-left:20px;line-height:1.6}</style></head><body>
<h1>🚌 Servis Takip – Demo</h1>
<div class="card"><h3>Nasıl denenir?</h3><ol>
<li><b>Firma paneli</b>ne gir (kullanıcı: <b>demo</b>, şifre: <b>demo123</b>).</li>
<li><b>Canlı</b> sekmesinde Servis 1'in yanındaki <b>▶ Sabah simülasyonu</b>na bas.</li>
<li>Bu sayfaya geri dön (tarayıcıda geri), bir <b>veli ekranı</b> aç: servisin kaç dakikada geleceğini gör.</li>
</ol>
<a class="big" href="/login">🏢 Firma paneli (giriş)</a></div>
${busHtml}
</body></html>`);
});
app.get('/v/:token', page('parent.html'));
app.get('/d/:token', page('driver.html'));
app.get('/login', page('login.html'));

app.get('/healthz', (req, res) => res.send('ok'));
app.get('/api/config', (req, res) => res.json({
  // Tarayıcı anahtarı herkese açıktır; Google Cloud'da sadece bizim alan adımıza kısıtlanmalı
  map: process.env.GOOGLE_MAPS_BROWSER_KEY
    ? { provider: 'google', key: process.env.GOOGLE_MAPS_BROWSER_KEY, mapId: process.env.GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID' }
    : {
      provider: 'leaflet',
      tileUrl: process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileAttribution: process.env.TILE_ATTRIBUTION || '&copy; OpenStreetMap katkıcıları',
    },
  pushKey: publicKey(),
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
const parentResponse = (s) => ({ ...parentView(s), pushEnabled: hasSubscription(s.id) });

app.get('/api/parent/:token', (req, res) => res.json(parentResponse(studentByToken(req.params.token))));

app.get('/api/parent/:token/stream', (req, res) => {
  const student = studentByToken(req.params.token);
  sse(req, res, (send) => {
    const push = () => {
      try { send('view', parentResponse(studentByToken(req.params.token))); } catch { res.end(); }
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
  res.json(parentResponse(studentByToken(req.params.token)));
}));

app.post('/api/parent/:token/settings', (req, res) => {
  const s = studentByToken(req.params.token);
  if (req.body.notifyMin != null) setNotifyMin(s.id, req.body.notifyMin);
  res.json(parentResponse(studentByToken(req.params.token)));
});

app.get('/api/parent/:token/history', (req, res) => {
  const s = studentByToken(req.params.token);
  res.json(attendanceHistory(s.id, 30));
});

app.post('/api/parent/:token/push', (req, res) => {
  const s = studentByToken(req.params.token);
  try { saveSubscription(s.id, req.body.subscription); } catch (e) { throw new HttpError(400, e.message); }
  res.json({ ok: true });
});
app.delete('/api/parent/:token/push', (req, res) => {
  studentByToken(req.params.token);
  if (req.body?.endpoint) removeSubscription(req.body.endpoint);
  res.json({ ok: true });
});

// iPhone'da "Ana Ekrana Ekle" ile açılınca doğru öğrencinin sayfası açılsın
app.get('/v/:token/manifest.webmanifest', (req, res) => {
  const s = studentByToken(req.params.token);
  res.type('application/manifest+json').json({
    name: `Servis – ${s.name}`,
    short_name: 'Servisim',
    start_url: `/v/${s.parent_token}`,
    scope: '/',
    display: 'standalone',
    background_color: '#f4f6f9',
    theme_color: '#f5a300',
    icons: [{ src: '/static/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  });
});

// --- Şoför ---------------------------------------------------------------
function busByToken(token) {
  const b = db.prepare('SELECT * FROM buses WHERE driver_token = ?').get(token);
  if (!b) throw new HttpError(404, 'Bağlantı geçersiz');
  return b;
}
const driverView = (b) => ({ bus: { id: b.id, name: b.name, plate: b.plate }, ...busView(b.id) });

app.get('/api/driver/:token', (req, res) => res.json(driverView(busByToken(req.params.token))));
app.get('/api/driver/:token/stream', (req, res) => {
  const b = busByToken(req.params.token);
  sse(req, res, (send) => {
    const push = throttled(() => send('view', driverView(b)), 500);
    const handler = (busId) => { if (busId === b.id) push(); };
    events.on('update', handler);
    send('view', driverView(b));
    return () => events.off('update', handler);
  });
});
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
  endTrip(b.id, { force: req.query.force === '1' });
  res.json(driverView(b));
});
app.post('/api/driver/:token/attendance', wrap(async (req, res) => {
  const b = busByToken(req.params.token);
  await markAttendance(b.id, Number(req.body.studentId), req.body.event);
  res.json(driverView(b));
}));
app.post('/api/driver/:token/school-drop', wrap(async (req, res) => {
  const b = busByToken(req.params.token);
  await dropAllAtSchool(b.id);
  res.json(driverView(b));
}));
app.post('/api/driver/:token/school-board', wrap(async (req, res) => {
  const b = busByToken(req.params.token);
  await boardAllAtSchool(b.id);
  res.json(driverView(b));
}));

// --- Giriş ---------------------------------------------------------------
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function currentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const row = db.prepare(`SELECT u.*, s.expires_at, c.active AS company_active, c.name AS company_name FROM sessions s
    JOIN users u ON u.id = s.user_id LEFT JOIN companies c ON c.id = u.company_id WHERE s.token = ?`).get(sid);
  if (!row || row.expires_at < Date.now()) return null;
  if (row.company_id != null && !row.company_active) return null; // firma pasife alındı
  return row;
}

const failed = new Map(); // ip -> {count, until}
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const f = failed.get(ip);
  if (f && f.count >= 10 && f.until > Date.now()) throw new HttpError(429, 'Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body.username || '').trim().toLowerCase());
  if (!user || !checkPassword(req.body.password || '', user.password_hash)) {
    const n = (f && f.until > Date.now() ? f.count : 0) + 1;
    failed.set(ip, { count: n, until: Date.now() + 15 * 60_000 });
    throw new HttpError(401, 'Kullanıcı adı veya şifre hatalı');
  }
  if (user.company_id != null && !db.prepare('SELECT active FROM companies WHERE id = ?').get(user.company_id)?.active) {
    throw new HttpError(403, 'Firma hesabı pasif. Lütfen bizimle iletişime geçin.');
  }
  failed.delete(ip);
  const token = newToken(24);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, Date.now() + SESSION_DAYS * 86400_000);
  res.set('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req).sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(sid);
  res.set('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

app.get('/admin', (req, res) => (currentUser(req) ? page('admin.html')(req, res) : res.redirect('/login')));

// --- Yönetici (firma panelleri) ------------------------------------------
app.use('/api/admin', (req, res, next) => {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Oturum süresi doldu, tekrar giriş yapın');
  req.user = user;
  req.isSuper = user.company_id == null;
  // Firma kullanıcısı sadece kendi firmasını görür; süper yönetici seçtiği firmayı
  req.companyId = req.isSuper ? Number(req.get('X-Company-Id') || req.query.company) || null : user.company_id;
  next();
});
const superOnly = (req, res, next) => (req.isSuper ? next() : next(new HttpError(403, 'Yetkiniz yok')));
function needCompany(req) {
  if (!req.companyId) throw new HttpError(400, 'Önce bir firma seçin');
  return req.companyId;
}
/** Kayıt bu firmaya ait mi? */
function owned(table, id, companyId) {
  if (id == null) return null;
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`).get(id, companyId);
  if (!row) throw new HttpError(404, 'Kayıt bulunamadı');
  return row;
}

app.get('/api/admin/me', (req, res) => {
  res.json({
    user: { name: req.user.name, username: req.user.username, isSuper: req.isSuper, companyName: req.user.company_name },
    companies: req.isSuper ? db.prepare('SELECT * FROM companies ORDER BY name').all() : [],
  });
});

function adminState(companyId) {
  const buses = db.prepare('SELECT * FROM buses WHERE company_id = ? ORDER BY name').all(companyId)
    .map((b) => ({ ...b, live: busView(b.id), simulating: isSimulating(b.id) }));
  return {
    schools: db.prepare('SELECT * FROM schools WHERE company_id = ? ORDER BY name').all(companyId),
    buses,
    students: db.prepare('SELECT * FROM students WHERE company_id = ? ORDER BY bus_id, stop_order, id').all(companyId),
    docAlerts: docAlerts(companyId),
    today: today(),
  };
}
/** 30 gün içinde süresi dolacak ya da dolmuş belgeler */
function docAlerts(companyId) {
  const limit = today(new Date(Date.now() + 30 * 86400_000));
  return db.prepare(`SELECT d.*, b.name AS bus_name FROM documents d LEFT JOIN buses b ON b.id = d.bus_id
    WHERE d.company_id = ? AND d.expires_on <= ? ORDER BY d.expires_on`).all(companyId, limit);
}
app.get('/api/admin/state', (req, res) => res.json(adminState(needCompany(req))));
app.get('/api/admin/stream', (req, res) => {
  const companyId = needCompany(req);
  sse(req, res, (send) => {
    const push = throttled(() => send('state', adminState(companyId)));
    const onUpdate = (busId) => {
      if (db.prepare('SELECT 1 FROM buses WHERE id = ? AND company_id = ?').get(busId, companyId)) push();
    };
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
  const c = needCompany(req), b = req.body;
  const r = db.prepare('INSERT INTO schools (company_id, name, lat, lng) VALUES (?, ?, ?, ?)')
    .run(c, required(str(b.name), 'Okul adı'), required(num(b.lat), 'Konum'), required(num(b.lng), 'Konum'));
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/admin/schools/:id', (req, res) => {
  const c = needCompany(req), b = req.body;
  owned('schools', req.params.id, c);
  db.prepare('UPDATE schools SET name = ?, lat = ?, lng = ? WHERE id = ?')
    .run(required(str(b.name), 'Okul adı'), required(num(b.lat), 'Konum'), required(num(b.lng), 'Konum'), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/schools/:id', (req, res) => {
  owned('schools', req.params.id, needCompany(req));
  db.prepare('DELETE FROM schools WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Servisler
function busFields(b, c) {
  const schoolId = num(b.school_id);
  owned('schools', schoolId, c);
  return [required(str(b.name), 'Servis adı'), str(b.plate), str(b.driver_name), str(b.driver_phone), schoolId, str(b.external_id)];
}
app.post('/api/admin/buses', (req, res) => {
  const c = needCompany(req);
  const r = db.prepare(`INSERT INTO buses (name, plate, driver_name, driver_phone, school_id, external_id, company_id, driver_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...busFields(req.body, c), c, newToken());
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/admin/buses/:id', (req, res) => {
  const c = needCompany(req);
  owned('buses', req.params.id, c);
  db.prepare(`UPDATE buses SET name = ?, plate = ?, driver_name = ?, driver_phone = ?, school_id = ?, external_id = ? WHERE id = ?`)
    .run(...busFields(req.body, c), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/buses/:id', (req, res) => {
  const id = owned('buses', req.params.id, needCompany(req)).id;
  stopSimulation(id);
  forgetBus(id);
  db.prepare('DELETE FROM buses WHERE id = ?').run(id);
  res.json({ ok: true });
});
app.post('/api/admin/buses/:id/trip', wrap(async (req, res) => {
  const id = owned('buses', req.params.id, needCompany(req)).id;
  await startTrip(id, req.body.type);
  res.json({ ok: true });
}));
app.delete('/api/admin/buses/:id/trip', (req, res) => {
  const id = owned('buses', req.params.id, needCompany(req)).id;
  endTrip(id, { force: req.query.force === '1' });
  stopSimulation(id);
  res.json({ ok: true });
});
app.post('/api/admin/buses/:id/simulate', wrap(async (req, res) => {
  const id = owned('buses', req.params.id, needCompany(req)).id;
  await simulate(id, req.body.type);
  res.json({ ok: true });
}));
app.post('/api/admin/buses/:id/new-link', (req, res) => {
  owned('buses', req.params.id, needCompany(req));
  db.prepare('UPDATE buses SET driver_token = ? WHERE id = ?').run(newToken(), req.params.id);
  res.json({ ok: true });
});

// Öğrenciler
function studentFields(b, c) {
  const busId = num(b.bus_id);
  owned('buses', busId, c);
  const fee = num(b.monthly_fee);
  if (fee != null && (!Number.isFinite(fee) || fee < 0)) throw new HttpError(400, 'Aylık ücret geçersiz');
  return [required(str(b.name), 'Öğrenci adı'), busId, str(b.address), num(b.lat), num(b.lng), num(b.stop_order) ?? 0, str(b.parent_name), str(b.parent_phone), fee];
}
app.post('/api/admin/students', (req, res) => {
  const c = needCompany(req);
  const r = db.prepare(`INSERT INTO students (name, bus_id, address, lat, lng, stop_order, parent_name, parent_phone, monthly_fee, company_id, parent_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...studentFields(req.body, c), c, newToken());
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/admin/students/:id', (req, res) => {
  const c = needCompany(req);
  owned('students', req.params.id, c);
  db.prepare(`UPDATE students SET name = ?, bus_id = ?, address = ?, lat = ?, lng = ?, stop_order = ?, parent_name = ?, parent_phone = ?, monthly_fee = ? WHERE id = ?`)
    .run(...studentFields(req.body, c), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/students/:id', (req, res) => {
  owned('students', req.params.id, needCompany(req));
  db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
// Link sızarsa yenilemek için (eski linkin bildirim abonelikleri de silinir)
app.post('/api/admin/students/:id/new-link', (req, res) => {
  owned('students', req.params.id, needCompany(req));
  db.prepare('UPDATE students SET parent_token = ? WHERE id = ?').run(newToken(), req.params.id);
  db.prepare('DELETE FROM push_subs WHERE student_id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Yoklama raporu
app.get('/api/admin/attendance', (req, res) => {
  const c = needCompany(req);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today();
  const rows = db.prepare(`SELECT a.student_id, a.trip_type, a.event, a.at FROM attendance a
    WHERE a.company_id = ? AND a.date = ? ORDER BY a.id`).all(c, date);
  const students = db.prepare('SELECT id, name, bus_id, absent_on FROM students WHERE company_id = ? ORDER BY bus_id, stop_order, id').all(c);
  const map = new Map(students.map((s) => [s.id, { ...s, parentAbsent: s.absent_on === date, morning: {}, afternoon: {} }]));
  for (const r of rows) map.get(r.student_id)?.[r.trip_type] && (map.get(r.student_id)[r.trip_type][r.event] = r.at);
  res.json({ date, students: [...map.values()] });
});

// Duyurular
app.get('/api/admin/announcements', (req, res) => {
  res.json(db.prepare(`SELECT a.*, b.name AS bus_name FROM announcements a LEFT JOIN buses b ON b.id = a.bus_id
    WHERE a.company_id = ? ORDER BY a.id DESC LIMIT 50`).all(needCompany(req)));
});
app.post('/api/admin/announcements', (req, res) => {
  const c = needCompany(req);
  const text = required(str(req.body.text), 'Duyuru metni');
  if (text.length > 300) throw new HttpError(400, 'Duyuru en fazla 300 karakter olabilir');
  const busId = num(req.body.bus_id);
  owned('buses', busId, c);
  res.json(announce(c, busId, text));
});
app.delete('/api/admin/announcements/:id', (req, res) => {
  owned('announcements', req.params.id, needCompany(req));
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Aidat / servis ücreti
app.get('/api/admin/payments', (req, res) => {
  const c = needCompany(req);
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const rows = db.prepare(`SELECT s.id AS student_id, s.name, s.bus_id, s.parent_name, s.parent_phone, s.monthly_fee,
      p.id AS payment_id, p.amount, p.paid_at
    FROM students s LEFT JOIN payments p ON p.student_id = s.id AND p.month = ?
    WHERE s.company_id = ? ORDER BY s.bus_id, s.stop_order, s.id`).all(month, c);
  res.json({ month, rows });
});
app.post('/api/admin/payments', (req, res) => {
  const c = needCompany(req);
  const s = owned('students', num(req.body.student_id), c);
  const month = /^\d{4}-\d{2}$/.test(req.body.month || '') ? req.body.month : today().slice(0, 7);
  const amount = num(req.body.amount) ?? s.monthly_fee;
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Tutar girin (öğrencinin aylık ücretini kaydedin)');
  db.prepare(`INSERT INTO payments (company_id, student_id, month, amount, paid_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(student_id, month) DO UPDATE SET amount = excluded.amount, paid_at = excluded.paid_at`).run(c, s.id, month, amount, Date.now());
  res.json({ ok: true });
});
app.delete('/api/admin/payments/:id', (req, res) => {
  owned('payments', req.params.id, needCompany(req));
  db.prepare('DELETE FROM payments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Belgeler (muayene, sigorta, ehliyet...)
app.get('/api/admin/documents', (req, res) => {
  res.json(db.prepare(`SELECT d.*, b.name AS bus_name FROM documents d LEFT JOIN buses b ON b.id = d.bus_id
    WHERE d.company_id = ? ORDER BY d.expires_on`).all(needCompany(req)));
});
function docFields(b, c) {
  const busId = num(b.bus_id);
  owned('buses', busId, c);
  const exp = str(b.expires_on);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp || '')) throw new HttpError(400, 'Bitiş tarihi gerekli');
  return [busId, required(str(b.kind), 'Belge türü'), exp, str(b.note)];
}
app.post('/api/admin/documents', (req, res) => {
  const c = needCompany(req);
  const r = db.prepare('INSERT INTO documents (bus_id, kind, expires_on, note, company_id) VALUES (?, ?, ?, ?, ?)').run(...docFields(req.body, c), c);
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/admin/documents/:id', (req, res) => {
  const c = needCompany(req);
  owned('documents', req.params.id, c);
  db.prepare('UPDATE documents SET bus_id = ?, kind = ?, expires_on = ?, note = ? WHERE id = ?').run(...docFields(req.body, c), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/documents/:id', (req, res) => {
  owned('documents', req.params.id, needCompany(req));
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Süper yönetici: firmalar ve kullanıcılar ----------------------------
app.get('/api/admin/companies', superOnly, (req, res) => {
  res.json(db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM buses b WHERE b.company_id = c.id) AS bus_count,
      (SELECT COUNT(*) FROM students s WHERE s.company_id = c.id) AS student_count,
      (SELECT GROUP_CONCAT(username, ', ') FROM users u WHERE u.company_id = c.id) AS usernames
    FROM companies c ORDER BY c.name`).all());
});
app.post('/api/admin/companies', superOnly, (req, res) => {
  const b = req.body;
  const username = required(str(b.username), 'Kullanıcı adı').toLowerCase();
  const password = required(str(b.password), 'Şifre');
  if (password.length < 6) throw new HttpError(400, 'Şifre en az 6 karakter olmalı');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(400, 'Bu kullanıcı adı alınmış');
  const id = Number(db.prepare('INSERT INTO companies (name, phone) VALUES (?, ?)').run(required(str(b.name), 'Firma adı'), str(b.phone)).lastInsertRowid);
  db.prepare('INSERT INTO users (company_id, username, password_hash, name) VALUES (?, ?, ?, ?)').run(id, username, hashPassword(password), str(b.name));
  res.json({ id });
});
app.put('/api/admin/companies/:id', superOnly, (req, res) => {
  const b = req.body;
  db.prepare('UPDATE companies SET name = ?, phone = ?, active = ? WHERE id = ?')
    .run(required(str(b.name), 'Firma adı'), str(b.phone), b.active === false || b.active === '0' ? 0 : 1, req.params.id);
  if (str(b.password)) {
    if (b.password.length < 6) throw new HttpError(400, 'Şifre en az 6 karakter olmalı');
    db.prepare('UPDATE users SET password_hash = ? WHERE company_id = ?').run(hashPassword(b.password), req.params.id);
    db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)').run(req.params.id);
  }
  res.json({ ok: true });
});
app.delete('/api/admin/companies/:id', superOnly, (req, res) => {
  const buses = db.prepare('SELECT id FROM buses WHERE company_id = ?').all(req.params.id);
  for (const b of buses) { stopSimulation(b.id); forgetBus(b.id); }
  db.prepare('DELETE FROM companies WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Firma kullanıcısının kendi şifresini değiştirmesi
app.post('/api/admin/password', (req, res) => {
  if (!checkPassword(req.body.current || '', req.user.password_hash)) throw new HttpError(400, 'Mevcut şifre hatalı');
  const pw = String(req.body.password || '');
  if (pw.length < 6) throw new HttpError(400, 'Şifre en az 6 karakter olmalı');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), req.user.id);
  res.json({ ok: true });
});

// --- Hatalar -------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Bulunamadı' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Sunucu hatası' : err.message, ...(err.extra || {}) });
});

// --- Günlük yedek ----------------------------------------------------------
// Veritabanının günlük kopyası aynı diskteki backups klasörüne alınır, son 14 gün saklanır.
// (Diskin kendisi bozulursa diye ayrıca haftada bir bilgisayara indirilmesi önerilir: KURULUM.md)
const BACKUP_DIR = process.env.BACKUP_DIR || (DB_FILE === ':memory:' ? null : path.join(path.dirname(DB_FILE), 'backups'));
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP_DAYS || 14);
export function backupNow() {
  if (!BACKUP_DIR) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `servis-${today()}.db`);
  if (existsSync(file)) return file;
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = readdirSync(BACKUP_DIR).filter((f) => /^servis-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -BACKUP_KEEP);
  for (const f of old) unlinkSync(path.join(BACKUP_DIR, f));
  console.log('[yedek]', file);
  return file;
}
function scheduleBackups() {
  const run = () => { try { backupNow(); } catch (e) { console.error('[yedek] alınamadı:', e.message); } };
  run();
  setInterval(run, 60 * 60 * 1000).unref(); // saatte bir bakar, günde bir dosya
}

// Kapanırken son durumu kaydet (Railway yeniden başlatırken SIGTERM gönderir)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const b of db.prepare('SELECT id FROM buses').all()) saveBus(b.id);
    process.exit(0);
  });
}
process.on('unhandledRejection', (e) => console.error('[beklenmeyen hata]', e));

app.listen(PORT, () => {
  scheduleBackups();
  console.log(`Servis takip çalışıyor: http://localhost:${PORT}/admin`);
  startExternalProvider();
});
