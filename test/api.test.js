// Sunucuyu gerçekten çalıştırıp HTTP üzerinden test eder: giriş, firma ayrımı, veli/şoför linkleri.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: ':memory:', ROUTING: 'simple', PUSH_DISABLED: '1', ADMIN_USER: 'patron', ADMIN_PASSWORD: 'gizli123' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/config`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('Sunucu açılmadı');
});
after(() => server.kill());

async function login(username, password) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!res.ok) return null;
  return res.headers.get('set-cookie').split(';')[0];
}
function client(cookie, companyId) {
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', ...(companyId ? { 'X-Company-Id': String(companyId) } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

test('giriş olmadan panel API kapalı', async () => {
  const res = await fetch(`${base}/api/admin/state`);
  assert.equal(res.status, 401);
  assert.equal(await login('patron', 'yanlis'), null);
});

test('firmalar birbirinin verisini göremez', async () => {
  const sup = client(await login('patron', 'gizli123'));
  const c1 = (await sup('POST', '/api/admin/companies', { name: 'Firma 1', username: 'f1', password: 'sifre111' })).body.id;
  const c2 = (await sup('POST', '/api/admin/companies', { name: 'Firma 2', username: 'f2', password: 'sifre222' })).body.id;
  assert.ok(c1 && c2);

  const f1 = client(await login('f1', 'sifre111'));
  const f2 = client(await login('f2', 'sifre222'));

  const school = (await f1('POST', '/api/admin/schools', { name: 'Okul 1', lat: 41, lng: 29 })).body.id;
  const bus = (await f1('POST', '/api/admin/buses', { name: 'Servis A', school_id: school })).body.id;
  const st = await f1('POST', '/api/admin/students', { name: 'Ali', bus_id: bus, lat: 41.01, lng: 29.01 });
  assert.equal(st.status, 200);

  const s2 = await f2('GET', '/api/admin/state');
  assert.equal(s2.body.buses.length, 0);
  assert.equal(s2.body.students.length, 0);

  // Firma 2, Firma 1'in kayıtlarına dokunamaz
  assert.equal((await f2('PUT', `/api/admin/buses/${bus}`, { name: 'Ele geçirildi' })).status, 404);
  assert.equal((await f2('DELETE', `/api/admin/students/${st.body.id}`)).status, 404);
  assert.equal((await f2('POST', '/api/admin/students', { name: 'X', bus_id: bus })).status, 404);
  assert.equal((await f2('POST', `/api/admin/buses/${bus}/simulate`, { type: 'morning' })).status, 404);

  // Firma kullanıcısı firma listesine erişemez
  assert.equal((await f1('GET', '/api/admin/companies')).status, 403);

  // Süper yönetici firma seçerek görür
  const supAs1 = client((await login('patron', 'gizli123')), c1);
  assert.equal((await supAs1('GET', '/api/admin/state')).body.buses.length, 1);

  // Pasife alınan firma giremez
  await sup('PUT', `/api/admin/companies/${c2}`, { name: 'Firma 2', active: '0' });
  assert.equal(await login('f2', 'sifre222'), null);
  assert.equal((await f2('GET', '/api/admin/state')).status, 401);
});

test('şoför linkiyle yoklama, veli linkiyle takip', async () => {
  const sup = client(await login('patron', 'gizli123'));
  const cid = (await sup('POST', '/api/admin/companies', { name: 'Firma 3', username: 'f3', password: 'sifre333' })).body.id;
  const f3 = client(await login('f3', 'sifre333'));
  const school = (await f3('POST', '/api/admin/schools', { name: 'Okul', lat: 41.0255, lng: 29.096 })).body.id;
  const bus = (await f3('POST', '/api/admin/buses', { name: 'S', school_id: school })).body.id;
  await f3('POST', '/api/admin/students', { name: 'Veli Testi', bus_id: bus, lat: 41.03, lng: 29.09, stop_order: 1 });
  const state = (await f3('GET', '/api/admin/state')).body;
  const driver = state.buses[0].driver_token;
  const parent = state.students[0].parent_token;
  assert.ok(cid);

  const d = client('');
  await d('POST', `/api/driver/${driver}/location`, { lat: 41.04, lng: 29.08, accuracy: 10 });
  const started = await d('POST', `/api/driver/${driver}/trip`, { type: 'morning' });
  assert.equal(started.status, 200);
  const sid = started.body.trip.riders[0].studentId;
  assert.equal((await d('POST', `/api/driver/${driver}/attendance`, { studentId: sid, event: 'boarded' })).status, 200);

  const pv = (await d('GET', `/api/parent/${parent}`)).body;
  assert.ok(pv.attendance.morning.boarded);
  assert.equal(pv.pushEnabled, false);

  // Bitirmek isteyince araçta öğrenci var uyarısı
  const end = await d('DELETE', `/api/driver/${driver}/trip`);
  assert.equal(end.status, 409);
  assert.deepEqual(end.body.onBoard, ['Veli Testi']);
  assert.equal((await d('POST', `/api/driver/${driver}/school-drop`)).status, 200);
  assert.equal((await d('DELETE', `/api/driver/${driver}/trip`)).status, 200);

  // Geçersiz bildirim aboneliği reddedilir
  assert.equal((await d('POST', `/api/parent/${parent}/push`, { subscription: { endpoint: 'http://kotu' } })).status, 400);
  // Manifest öğrenciye özel
  const mf = await fetch(`${base}/v/${parent}/manifest.webmanifest`).then((r) => r.json());
  assert.equal(mf.start_url, `/v/${parent}`);

  // Başka firmanın şoför linkiyle öğrenci yoklaması yapılamaz
  assert.equal((await d('POST', `/api/driver/yanlis-token/attendance`, { studentId: sid, event: 'boarded' })).status, 404);
});

test('duyuru, aidat, belge ve kardeş linki', async () => {
  const sup = client(await login('patron', 'gizli123'));
  await sup('POST', '/api/admin/companies', { name: 'Firma 5', username: 'f5', password: 'sifre555' });
  await sup('POST', '/api/admin/companies', { name: 'Firma 6', username: 'f6', password: 'sifre666' });
  const f3 = client(await login('f5', 'sifre555'));
  const f4 = client(await login('f6', 'sifre666'));

  const school = (await f3('POST', '/api/admin/schools', { name: 'Okul', lat: 41, lng: 29 })).body.id;
  const bus = (await f3('POST', '/api/admin/buses', { name: 'S', school_id: school })).body.id;
  const a = (await f3('POST', '/api/admin/students', { name: 'Ayşe', bus_id: bus, lat: 41.01, lng: 29.01, parent_phone: '0532 111 22 33', monthly_fee: 2500 })).body.id;
  await f3('POST', '/api/admin/students', { name: 'Ali', bus_id: bus, lat: 41.01, lng: 29.01, parent_phone: '+90 532 111 2233' });
  const state = (await f3('GET', '/api/admin/state')).body;
  const ayse = state.students.find((s) => s.id === a);
  assert.equal(ayse.monthly_fee, 2500);

  // Duyuru veliye gider
  const ann = await f3('POST', '/api/admin/announcements', { text: 'Yarın servis 10 dk erken' });
  assert.equal(ann.body.sent, 2);
  let pv = await (await fetch(`${base}/api/parent/${ayse.parent_token}`)).json();
  assert.equal(pv.announcements[0].text, 'Yarın servis 10 dk erken');
  assert.match(pv.messages[0].text, /10 dk erken/);
  // Kardeş: telefon farklı yazılmış olsa da eşleşir
  assert.deepEqual(pv.siblings.map((s) => s.name), ['Ali']);
  // Aidat: önce ödenmedi, sonra ödendi
  assert.equal(pv.fee.paid, false);
  assert.equal((await f3('POST', '/api/admin/payments', { student_id: a })).status, 200);
  pv = await (await fetch(`${base}/api/parent/${ayse.parent_token}`)).json();
  assert.equal(pv.fee.paid, true);
  assert.equal(pv.fee.amount, 2500);
  const pays = (await f3('GET', '/api/admin/payments')).body;
  assert.equal(pays.rows.find((r) => r.student_id === a).amount, 2500);

  // Başka firma bu öğrencinin ödemesini işaretleyemez, duyuru da gönderemez
  assert.equal((await f4('POST', '/api/admin/payments', { student_id: a })).status, 404);
  assert.equal((await f4('POST', '/api/admin/announcements', { text: 'x', bus_id: bus })).status, 404);

  // Belge: 30 gün içinde bitecekse uyarı listesinde çıkar
  const soon = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
  await f3('POST', '/api/admin/documents', { bus_id: bus, kind: 'Araç muayenesi', expires_on: soon });
  await f3('POST', '/api/admin/documents', { bus_id: bus, kind: 'Sigorta', expires_on: later });
  assert.equal((await f3('POST', '/api/admin/documents', { bus_id: bus, kind: 'X' })).status, 400);
  const st2 = (await f3('GET', '/api/admin/state')).body;
  assert.deepEqual(st2.docAlerts.map((d) => d.kind), ['Araç muayenesi']);
  assert.equal((await f4('GET', '/api/admin/documents')).body.length, 0);
});
