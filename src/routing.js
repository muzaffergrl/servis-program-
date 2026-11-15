// Güzergâh ve süre hesabı.
//
// Strateji: sefer başında tüm duraklar için TEK bir rota isteği atılır. Canlı takipte
// servisin konumu bu rotanın üzerine izdüşürülür ve kalan süre rotadan okunur.
// Google kullanılıyorsa rota, güncel trafiğe göre birkaç dakikada bir tazelenir
// (tracker.js, ROUTE_REFRESH_SEC).
//
// Sağlayıcılar:
//  - google : Google Routes API, canlı trafiğe göre (GOOGLE_MAPS_SERVER_KEY gerekir) — canlı kullanım
//  - osrm   : ücretsiz, trafiksiz — geliştirme
//  - simple : internet yok, kuş uçuşu tahmin — test

const OSRM_URL = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
const GOOGLE_KEY = process.env.GOOGLE_MAPS_SERVER_KEY || '';
export const MODE = process.env.ROUTING || (GOOGLE_KEY ? 'google' : 'osrm'); // 'google' | 'osrm' | 'simple'
const GOOGLE_MAX_POINTS = 27; // başlangıç + 25 ara durak + bitiş
const SIMPLE_SPEED = Number(process.env.SIMPLE_SPEED_KMH || 25) / 3.6; // m/sn, şehir içi ortalama
const ROAD_FACTOR = 1.35; // kuş uçuşu mesafeyi yol mesafesine çevirme katsayısı

/** İki nokta arası metre. a, b = [lat, lng] */
export function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const cache = new Map();

/**
 * points: [[lat,lng], ...] sırasıyla gidilecek noktalar.
 * Dönüş: { coords, cumDur, stopIdx, source }
 *  - coords: rota çizgisi
 *  - cumDur: her koordinata kadar geçen süre (sn)
 *  - stopIdx: her girdi noktasının coords içindeki indeksi
 */
export async function planRoute(points) {
  if (points.length === 0) throw new Error('Rota için nokta yok');
  if (points.length === 1) return { coords: [points[0]], cumDur: [0], stopIdx: [0], source: 'single' };

  // Google sonuçları güncel trafiğe bağlı ve Google kuralları gereği saklanmaz; diğerleri önbelleğe alınır
  const key = points.map((p) => p.map((v) => v.toFixed(5)).join(',')).join(';');
  if (MODE !== 'google' && cache.has(key)) return cache.get(key);

  let route = null;
  if (MODE === 'google') {
    try {
      route = await googleRoute(points);
    } catch (e) {
      console.warn(`[routing] Google Routes kullanılamadı (${e.message}), basit tahmine geçiliyor`);
    }
  } else if (MODE === 'osrm') {
    try {
      route = await osrmRoute(points);
    } catch (e) {
      console.warn(`[routing] OSRM kullanılamadı (${e.message}), basit tahmine geçiliyor`);
    }
  }
  if (!route) route = simpleRoute(points);

  if (MODE !== 'google') {
    if (cache.size > 500) cache.clear();
    cache.set(key, route);
  }
  return route;
}

// --- Google Routes API ---------------------------------------------------

/** Google'ın kodlanmış çizgi (encoded polyline) formatını çözer → [[lat,lng], ...] */
export function decodePolyline(str) {
  const out = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

const parseSec = (s) => Number(String(s ?? '0').replace(/s$/, '')) || 0;

/** Tek bir Routes API isteği (en fazla 27 nokta) → bacak listesi [{coords, duration}] */
async function googleLegs(points, fetchFn = fetch) {
  const wp = ([lat, lng]) => ({ location: { latLng: { latitude: lat, longitude: lng } } });
  const body = {
    origin: wp(points[0]),
    destination: wp(points.at(-1)),
    intermediates: points.slice(1, -1).map(wp),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE', // canlı trafik (Pro fiyatı)
    polylineQuality: 'HIGH_QUALITY',
    languageCode: 'tr',
    regionCode: 'TR',
    units: 'METRIC',
  };
  const res = await fetchFn('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY,
      // Sadece gereken alanlar istenir (fazlası daha pahalı faturalanabilir)
      'X-Goog-FieldMask': 'routes.legs.duration,routes.legs.distanceMeters,routes.legs.polyline.encodedPolyline',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${data.error?.message || ''}`.trim());
  const legs = data.routes?.[0]?.legs;
  if (!legs?.length || legs.length !== points.length - 1) throw new Error('rota bulunamadı');
  return legs.map((l, i) => {
    const coords = l.polyline?.encodedPolyline ? decodePolyline(l.polyline.encodedPolyline) : [];
    if (coords.length < 2) return { coords: [points[i], points[i + 1]], duration: parseSec(l.duration) };
    return { coords, duration: parseSec(l.duration) };
  });
}

/** Bacakları tek rota yapısına çevirir; her bacağın süresi kendi mesafesine orantılı dağıtılır */
export function legsToRoute(legs, source) {
  const coords = [];
  const cumDur = [];
  const stopIdx = [0];
  let t = 0;
  legs.forEach((leg, li) => {
    const pts = leg.coords;
    const d = [0];
    for (let k = 1; k < pts.length; k++) d.push(d[k - 1] + haversine(pts[k - 1], pts[k]));
    const total = d.at(-1);
    // İlk bacak hariç, bacağın ilk noktası önceki bacağın son noktasıyla aynı durak: tekrar ekleme
    for (let k = li === 0 ? 0 : 1; k < pts.length; k++) {
      coords.push(pts[k]);
      cumDur.push(t + (total > 0 ? (d[k] / total) * leg.duration : (k === pts.length - 1 ? leg.duration : 0)));
    }
    t += leg.duration;
    stopIdx.push(coords.length - 1);
  });
  return { coords, cumDur, stopIdx, source };
}

export async function googleRoute(points, fetchFn = fetch) {
  // 25 ara durak sınırı: uzun turları parçalara böl (parçalar uç noktada birleşir)
  const legs = [];
  for (let i = 0; i < points.length - 1; i += GOOGLE_MAX_POINTS - 1) {
    legs.push(...await googleLegs(points.slice(i, i + GOOGLE_MAX_POINTS), fetchFn));
  }
  return legsToRoute(legs, 'google');
}

async function osrmRoute(points) {
  const coordStr = points.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(';');
  const url = `${OSRM_URL}/route/v1/driving/${coordStr}?overview=full&geometries=geojson`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error(data.code || 'rota yok');

  const r = data.routes[0];
  const coords = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  const cumDist = [0];
  for (let i = 1; i < coords.length; i++) cumDist.push(cumDist[i - 1] + haversine(coords[i - 1], coords[i]));

  // Her durağın rota çizgisi üzerindeki yerini bul (ileri doğru arayarak)
  const stopIdx = [];
  let from = 0;
  for (const wp of data.waypoints) {
    const p = [wp.location[1], wp.location[0]];
    let best = from;
    let bestD = Infinity;
    for (let i = from; i < coords.length; i++) {
      const d = haversine(p, coords[i]);
      if (d < bestD) { bestD = d; best = i; }
      if (d < 3) break;
    }
    stopIdx.push(best);
    from = best;
  }

  // Her bacağın OSRM süresini, bacak içindeki mesafeye orantılı dağıt
  const cumDur = new Array(coords.length).fill(0);
  for (let leg = 0; leg < r.legs.length; leg++) {
    const a = stopIdx[leg];
    const b = stopIdx[leg + 1];
    const legDist = cumDist[b] - cumDist[a];
    const scale = legDist > 0 ? r.legs[leg].duration / legDist : 0;
    for (let k = a + 1; k <= b; k++) cumDur[k] = cumDur[a] + (cumDist[k] - cumDist[a]) * scale;
  }
  return { coords, cumDur, stopIdx, source: 'osrm' };
}

/** İnternet / OSRM yoksa: kuş uçuşu × katsayı / ortalama hız */
function simpleRoute(points) {
  const cumDur = [0];
  for (let i = 1; i < points.length; i++) {
    cumDur.push(cumDur[i - 1] + (haversine(points[i - 1], points[i]) * ROAD_FACTOR) / SIMPLE_SPEED);
  }
  return { coords: points.slice(), cumDur, stopIdx: points.map((_, i) => i), source: 'simple' };
}

// --- Konumu rota üzerine izdüşürme ---------------------------------------

function projectOnSegment(p, a, b) {
  // Küçük mesafelerde düzlem yaklaşımı yeterli
  const kx = Math.cos((p[0] * Math.PI) / 180) * 111320;
  const ky = 110540;
  const ax = a[1] * kx, ay = a[0] * ky;
  const bx = b[1] * kx, by = b[0] * ky;
  const px = p[1] * kx, py = p[0] * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return { t, dist: Math.hypot(px - qx, py - qy) };
}

/**
 * Konumu rotaya izdüşürür. fromIdx: son bilinen ilerleme (geri sıçramayı önler).
 * Dönüş: { idx, dur, dist } — dur: rota başından bu noktaya süre, dist: rotaya uzaklık (m)
 */
export function projectOnRoute(route, pos, fromIdx = 0) {
  const { coords, cumDur } = route;
  if (coords.length === 1) return { idx: 0, dur: 0, dist: haversine(pos, coords[0]) };

  const search = (start, end) => {
    let best = null;
    for (let i = start; i < end; i++) {
      const pr = projectOnSegment(pos, coords[i], coords[i + 1]);
      if (!best || pr.dist < best.dist) {
        best = { idx: i, dist: pr.dist, dur: cumDur[i] + pr.t * (cumDur[i + 1] - cumDur[i]) };
      }
    }
    return best;
  };

  const last = coords.length - 1;
  // Önce son ilerlemenin biraz gerisinden ileriye doğru ara
  let best = search(Math.max(0, fromIdx - 3), Math.min(last, fromIdx + 400));
  if (!best || best.dist > 150) {
    const all = search(0, last);
    if (!best || all.dist < best.dist) best = all;
  }
  return best;
}

/** Rota üzerinde t saniyedeki konum (simülatör için) */
export function pointAt(route, t) {
  const { coords, cumDur } = route;
  if (t <= 0) return coords[0];
  if (t >= cumDur.at(-1)) return coords.at(-1);
  let lo = 0, hi = cumDur.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumDur[mid] <= t) lo = mid; else hi = mid;
  }
  const span = cumDur[hi] - cumDur[lo];
  const f = span > 0 ? (t - cumDur[lo]) / span : 0;
  return [coords[lo][0] + f * (coords[hi][0] - coords[lo][0]), coords[lo][1] + f * (coords[hi][1] - coords[lo][1])];
}
