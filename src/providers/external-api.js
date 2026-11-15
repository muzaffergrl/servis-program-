// Servisçilerin kullandığı mevcut takip programından konum çekme.
//
// API adresi ve belgeleri gelince burası doldurulacak. Mantık:
//   1) Belirli aralıklarla (ör. 10 sn) API'den tüm araçların son konumunu çek
//   2) Her aracın kimliğini buses.external_id ile eşleştir
//   3) tracker.updatePosition(busId, lat, lng) çağır
//
// Ortam değişkenleri: EXTERNAL_API_URL, EXTERNAL_API_KEY, EXTERNAL_POLL_SEC
import { db } from '../db.js';
import { updatePosition } from '../tracker.js';

export function startExternalProvider() {
  const url = process.env.EXTERNAL_API_URL;
  if (!url) return;
  const every = Number(process.env.EXTERNAL_POLL_SEC || 10) * 1000;
  console.log(`[harici-api] ${every / 1000} sn'de bir konum çekilecek`);

  setInterval(async () => {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.EXTERNAL_API_KEY || ''}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const vehicles = parseVehicles(await res.json());
      const buses = db.prepare('SELECT id, external_id FROM buses WHERE external_id IS NOT NULL').all();
      for (const v of vehicles) {
        const bus = buses.find((b) => b.external_id === String(v.id));
        if (bus) await updatePosition(bus.id, v.lat, v.lng, { speed: v.speed });
      }
    } catch (e) {
      console.warn('[harici-api]', e.message);
    }
  }, every);
}

/** TODO: API'nin gerçek cevap formatına göre uyarlanacak */
function parseVehicles(data) {
  const list = Array.isArray(data) ? data : data.vehicles || [];
  return list.map((v) => ({
    id: v.id ?? v.vehicleId ?? v.plate,
    lat: Number(v.lat ?? v.latitude),
    lng: Number(v.lng ?? v.lon ?? v.longitude),
    speed: v.speed ?? null,
  }));
}
