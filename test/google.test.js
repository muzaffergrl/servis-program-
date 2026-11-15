// Google Routes API entegrasyonu: Google'ın cevabı taklit edilerek test edilir (internet gerekmez).
process.env.GOOGLE_MAPS_SERVER_KEY = 'test-anahtari';
process.env.DB_FILE = ':memory:';
process.env.PUSH_DISABLED = '1';
process.env.ROUTE_REFRESH_SEC = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { decodePolyline, googleRoute, MODE, projectOnRoute } = await import('../src/routing.js');

/** Google'ın polyline kodlayıcısı (test verisi üretmek için) */
function encode(points) {
  let out = '', plat = 0, plng = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lng] of points) {
    const a = Math.round(lat * 1e5), b = Math.round(lng * 1e5);
    out += enc(a - plat) + enc(b - plng);
    plat = a; plng = b;
  }
  return out;
}

/** Sahte Google: her bacak için düz çizgi ve 100 sn × bacak no süre döner */
function fakeGoogle(calls) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, body });
    const pts = [body.origin, ...body.intermediates, body.destination].map((w) => [w.location.latLng.latitude, w.location.latLng.longitude]);
    const legs = pts.slice(1).map((p, i) => {
      const a = pts[i];
      const mid = [(a[0] + p[0]) / 2, (a[1] + p[1]) / 2];
      return { duration: `${100 * (i + 1)}s`, distanceMeters: 1000, polyline: { encodedPolyline: encode([a, mid, p]) } };
    });
    return { ok: true, status: 200, json: async () => ({ routes: [{ legs }] }) };
  };
}

test('anahtar varsa Google kullanılır', () => {
  assert.equal(MODE, 'google');
});

test('Google polyline çözümü (Google belgelerindeki örnek)', () => {
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(pts, [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('istek doğru biçimde gider: trafik, ara duraklar, alan maskesi', async () => {
  const calls = [];
  const points = [[41.04, 29.07], [41.041, 29.079], [41.035, 29.086], [41.0255, 29.096]];
  const r = await googleRoute(points, fakeGoogle(calls));
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
  assert.equal(c.headers['X-Goog-Api-Key'], 'test-anahtari');
  assert.match(c.headers['X-Goog-FieldMask'], /routes\.legs\.duration/);
  assert.equal(c.body.routingPreference, 'TRAFFIC_AWARE');
  assert.equal(c.body.intermediates.length, 2);

  // Durak süreleri: 100, 100+200, 100+200+300
  assert.deepEqual(r.stopIdx.map((i) => Math.round(r.cumDur[i])), [0, 100, 300, 600]);
  // Süre rota boyunca hep artar
  for (let i = 1; i < r.cumDur.length; i++) assert.ok(r.cumDur[i] >= r.cumDur[i - 1]);
  // Bacak ortasındaki konum, bacak süresinin yarısına denk gelir
  const p = projectOnRoute(r, [(41.041 + 41.035) / 2, (29.079 + 29.086) / 2], 0);
  assert.ok(Math.abs(p.dur - 200) < 2, `beklenen ~200, gelen ${p.dur}`);
});

test('25 ara durak sınırı: uzun tur parçalara bölünür', async () => {
  const calls = [];
  const points = Array.from({ length: 40 }, (_, i) => [41 + i * 0.001, 29 + i * 0.001]);
  const r = await googleRoute(points, fakeGoogle(calls));
  assert.equal(calls.length, 2);
  for (const c of calls) assert.ok(c.body.intermediates.length <= 25);
  assert.equal(r.stopIdx.length, 40);
  // İkinci parça birinci parçanın bittiği yerden başlamalı
  const firstEnd = calls[0].body.destination.location.latLng;
  const secondStart = calls[1].body.origin.location.latLng;
  assert.deepEqual(firstEnd, secondStart);
});

test('Google hata verirse anlaşılır hata fırlatır', async () => {
  const bad = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'API key not valid' } }) });
  await assert.rejects(() => googleRoute([[41, 29], [41.01, 29.01]], bad), /403 API key not valid/);
});

test('tur sırasında rota trafiğe göre tazelenir', async () => {
  const { db, newToken } = await import('../src/db.js');
  const tracker = await import('../src/tracker.js');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeGoogle(calls);
  try {
    const c = Number(db.prepare('INSERT INTO companies (name) VALUES (?)').run('F').lastInsertRowid);
    const sc = Number(db.prepare('INSERT INTO schools (company_id, name, lat, lng) VALUES (?, ?, ?, ?)').run(c, 'Okul', 41.0255, 29.096).lastInsertRowid);
    const bus = Number(db.prepare('INSERT INTO buses (company_id, name, school_id, driver_token) VALUES (?, ?, ?, ?)').run(c, 'S', sc, newToken()).lastInsertRowid);
    db.prepare('INSERT INTO students (company_id, name, bus_id, lat, lng, parent_token) VALUES (?, ?, ?, ?, ?, ?)').run(c, 'A', bus, 41.04, 29.08, newToken());

    await tracker.updatePosition(bus, 41.05, 29.07);
    await tracker.startTrip(bus, 'morning');
    assert.equal(calls.length, 1);
    assert.equal(tracker.busView(bus).trip.routeSource, 'google');

    await tracker.updatePosition(bus, 41.049, 29.071);
    assert.equal(calls.length, 1, 'süre dolmadan yeniden sorulmamalı');
    await new Promise((r) => setTimeout(r, 1100));
    await tracker.updatePosition(bus, 41.048, 29.072);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 2, 'süre dolunca trafik için yeniden sorulmalı');
    tracker.endTrip(bus, { force: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});
