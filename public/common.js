// Sayfalar arasında ortak yardımcılar
const $ = (id) => document.getElementById(id);

const apiHeaders = {}; // yönetim panelinde seçili firma vb.

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { ...apiHeaders, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url.startsWith('/api/admin')) { location.href = '/login'; }
  if (!res.ok) throw Object.assign(new Error(data.error || `Hata (${res.status})`), { status: res.status, data });
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

// --- Harita ----------------------------------------------------------------
// Sunucu ayarına göre Google Haritalar (canlı kullanım) veya Leaflet/OpenStreetMap (geliştirme).
// Sayfalar haritayı aşağıdaki ortak arayüzle kullanır, hangisinin çalıştığını bilmez:
//   map.marker([lat,lng], {kind:'bus'|'pin', emoji, title, z}) → {setPos, setOpacity, setTitle, remove, pos}
//   map.fit([[lat,lng],...]), map.setView([lat,lng], zoom), map.onClick((lat,lng)=>{}), map.resize()

let configPromise;
const getConfig = () => (configPromise ||= fetch('/api/config').then((r) => r.json()));

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Harita yüklenemedi'));
    document.head.appendChild(s);
  });
}

let googlePromise;
function loadGoogle(key) {
  return (googlePromise ||= new Promise((resolve, reject) => {
    window.__gmReady = () => resolve(window.google);
    loadScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=tr&region=TR&loading=async&callback=__gmReady`)
      .catch(reject);
  }));
}

let leafletPromise;
function loadLeaflet() {
  return (leafletPromise ||= (async () => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    await loadScript('/vendor/leaflet/leaflet.js');
    return window.L;
  })());
}

function markerEl(kind, emoji) {
  const el = document.createElement('div');
  if (kind === 'bus') {
    el.className = 'bus-icon';
    el.style.cssText = 'width:38px;height:38px';
    el.textContent = '🚌';
  } else {
    el.className = 'pin-icon';
    el.textContent = emoji || '📍';
  }
  return el;
}

async function makeMap(el, center = [41.0255, 29.096], zoom = 13) {
  if (typeof el === 'string') el = document.getElementById(el);
  const cfg = await getConfig();
  return cfg.map.provider === 'google' ? googleMap(el, center, zoom, cfg.map) : leafletMap(el, center, zoom, cfg.map);
}

async function googleMap(el, center, zoom, cfg) {
  const g = await loadGoogle(cfg.key);
  const { Map } = await g.maps.importLibrary('maps');
  const { AdvancedMarkerElement } = await g.maps.importLibrary('marker');
  const map = new Map(el, {
    center: { lat: center[0], lng: center[1] }, zoom, mapId: cfg.mapId,
    gestureHandling: 'cooperative', clickableIcons: false, streetViewControl: false, mapTypeControl: false, fullscreenControl: false,
  });
  return {
    provider: 'google',
    native: map,
    marker(ll, { kind = 'pin', emoji, title, z } = {}) {
      const content = markerEl(kind, emoji);
      if (kind === 'pin') content.style.transform = 'translateY(4px)';
      const m = new AdvancedMarkerElement({ map, position: { lat: ll[0], lng: ll[1] }, content, title: title || '', zIndex: z });
      let pos = ll;
      return {
        setPos(p) { pos = p; m.position = { lat: p[0], lng: p[1] }; },
        setOpacity(o) { content.style.opacity = String(o); },
        setTitle(t) { m.title = t || ''; },
        remove() { m.map = null; },
        pos: () => pos,
      };
    },
    fit(points) {
      if (!points.length) return;
      if (points.length === 1) { map.setCenter({ lat: points[0][0], lng: points[0][1] }); map.setZoom(15); return; }
      const b = new g.maps.LatLngBounds();
      for (const p of points) b.extend({ lat: p[0], lng: p[1] });
      map.fitBounds(b, 48);
    },
    setView(p, z) { map.setCenter({ lat: p[0], lng: p[1] }); if (z) map.setZoom(z); },
    onClick(cb) { map.addListener('click', (e) => e.latLng && cb(e.latLng.lat(), e.latLng.lng())); },
    resize() { /* Google kendisi uyum sağlar */ },
  };
}

async function leafletMap(el, center, zoom, cfg) {
  const L = await loadLeaflet();
  const map = L.map(el, { zoomControl: true }).setView(center, zoom);
  L.tileLayer(cfg.tileUrl, { maxZoom: 19, attribution: cfg.tileAttribution }).addTo(map);
  return {
    provider: 'leaflet',
    native: map,
    marker(ll, { kind = 'pin', emoji, title, z } = {}) {
      const html = markerEl(kind, emoji).outerHTML;
      const icon = kind === 'bus'
        ? L.divIcon({ className: '', html, iconSize: [38, 38], iconAnchor: [19, 19] })
        : L.divIcon({ className: '', html, iconSize: [28, 28], iconAnchor: [14, 26] });
      const m = L.marker(ll, { icon, zIndexOffset: z || 0 }).addTo(map);
      if (title) m.bindTooltip(title);
      return {
        setPos(p) { m.setLatLng(p); },
        setOpacity(o) { m.setOpacity(o); },
        setTitle(t) { m.unbindTooltip(); if (t) m.bindTooltip(t); },
        remove() { m.remove(); },
        pos: () => { const p = m.getLatLng(); return [p.lat, p.lng]; },
      };
    },
    fit(points) {
      if (!points.length) return;
      if (points.length === 1) { map.setView(points[0], 15); return; }
      map.fitBounds(L.latLngBounds(points).pad(0.2));
    },
    setView(p, z) { map.setView(p, z || map.getZoom()); },
    onClick(cb) { map.on('click', (e) => cb(e.latlng.lat, e.latlng.lng)); },
    resize() { map.invalidateSize(); },
  };
}

/**
 * Adres arama kutusu (sadece Google ile). Seçilen adresin konumunu onPick(lat, lng, adres) ile döner.
 * Google yoksa false döner; sayfa "haritaya tıklayın" yöntemiyle devam eder.
 */
async function addressSearch(container, onPick, near) {
  const cfg = await getConfig();
  if (cfg.map.provider !== 'google') return false;
  const g = await loadGoogle(cfg.map.key);
  const { PlaceAutocompleteElement } = await g.maps.importLibrary('places');
  const opts = { includedRegionCodes: ['tr'] };
  if (near) opts.locationBias = { center: { lat: near[0], lng: near[1] }, radius: 30000 };
  const box = new PlaceAutocompleteElement(opts);
  box.style.width = '100%';
  container.replaceChildren(box);
  const handler = async (ev) => {
    try {
      const place = ev.placePrediction ? ev.placePrediction.toPlace() : ev.place;
      await place.fetchFields({ fields: ['location', 'formattedAddress'] });
      if (place.location) onPick(place.location.lat(), place.location.lng(), place.formattedAddress);
    } catch (e) { toast('Adres alınamadı: ' + e.message); }
  };
  // Google sürümüne göre olay adı değişebiliyor
  box.addEventListener('gmp-select', handler);
  box.addEventListener('gmp-placeselect', handler);
  return true;
}

/** Kopma durumunda kendiliğinden yeniden bağlanan SSE */
function liveStream(url, handlers, onState) {
  const es = new EventSource(url);
  for (const [ev, fn] of Object.entries(handlers)) es.addEventListener(ev, (e) => fn(JSON.parse(e.data)));
  es.onopen = () => onState?.(true);
  es.onerror = () => onState?.(false);
  return es;
}
