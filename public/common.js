// Sayfalar arasında ortak yardımcılar
const $ = (id) => document.getElementById(id);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Hata (${res.status})`);
  return data;
}

function toast(text, ms = 4000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
const fmtMin = (sec) => (sec == null ? '–' : Math.max(1, Math.round(sec / 60)));

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function makeMap(el, center = [41.0255, 29.096], zoom = 13) {
  const cfg = await fetch('/api/config').then((r) => r.json());
  const map = L.map(el, { zoomControl: true }).setView(center, zoom);
  L.tileLayer(cfg.tileUrl, { maxZoom: 19, attribution: cfg.tileAttribution }).addTo(map);
  return map;
}

const busIcon = () => L.divIcon({ className: '', html: '<div class="bus-icon" style="width:38px;height:38px">🚌</div>', iconSize: [38, 38], iconAnchor: [19, 19] });
const pinIcon = (emoji) => L.divIcon({ className: '', html: `<div class="pin-icon">${emoji}</div>`, iconSize: [28, 28], iconAnchor: [14, 26] });

/** Kopma durumunda kendiliğinden yeniden bağlanan SSE */
function liveStream(url, handlers, onState) {
  const es = new EventSource(url);
  for (const [ev, fn] of Object.entries(handlers)) es.addEventListener(ev, (e) => fn(JSON.parse(e.data)));
  es.onopen = () => onState?.(true);
  es.onerror = () => onState?.(false);
  return es;
}
