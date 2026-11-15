const token = location.pathname.split('/').pop();
let map, busMarker, homeMarker, schoolMarker, view, cfg, fitted = false;

// iPhone "Ana Ekrana Ekle" için bu öğrenciye özel manifest
const mf = document.createElement('link');
mf.rel = 'manifest';
mf.href = `/v/${token}/manifest.webmanifest`;
document.head.appendChild(mf);

function setLive(ok) {
  $('live').innerHTML = ok ? '<span class="dot ok"></span> canlı' : '<span class="dot warn"></span> bağlantı bekleniyor';
}

function etaCard(v) {
  const t = v.trip;
  const card = $('eta');
  card.classList.remove('ok', 'alert');
  const set = (big, label, sub = '') => { $('etaBig').innerHTML = big; $('etaLabel').textContent = label; $('etaSub').textContent = sub; };
  const me = t?.me || {};

  if (t?.type === 'afternoon' && me.absentAt) {
    card.classList.add('alert');
    return set('⚠️', 'Okul çıkışında servise binmedi', `Şoför ${fmtTime(me.absentAt)}'de işaretledi. Lütfen okulla iletişime geçin.`);
  }
  if (v.student.absentToday && (!t || !t.onTrip)) return set('🙋', 'Bugün servise binmeyecek olarak işaretlendi.');
  if (!t) return set('🕒', 'Servis henüz yola çıkmadı.', 'Servis yola çıkınca burada kalan süreyi göreceksiniz.');

  const morning = t.type === 'morning';
  if (morning && me.absentAt) return set('🙋', 'Bugün servise binmedi', `Şoför ${fmtTime(me.absentAt)}'de işaretledi.`);
  if (morning && me.droppedAt) { card.classList.add('ok'); return set('🏫', 'Okulda servisten indi', `İniş: ${fmtTime(me.droppedAt)}`); }
  if (!morning && me.droppedAt) { card.classList.add('ok'); return set('🏠', 'Öğrenciniz evde', `İniş: ${fmtTime(me.droppedAt)}`); }

  if (t.finishedAt) {
    card.classList.add('ok');
    return morning
      ? set('✅', 'Servis okula ulaştı', `Varış: ${fmtTime(t.school?.doneAt || t.finishedAt)}`)
      : set('✅', 'Akşam servisi tamamlandı', `Bitiş: ${fmtTime(t.finishedAt)}`);
  }
  if (!t.onTrip) return set('🚌', 'Servis yolda', 'Öğrenciniz bu seferde değil.');

  const my = t.myStop;
  if (morning) {
    if (!my.done) {
      const sub = my.stopsBefore > 0 ? `Sizden önce ${my.stopsBefore} öğrenci alınacak` : 'Sıradaki durak sizsiniz';
      return set(`${fmtMin(my.etaSec)} <small>dk</small>`, 'Servis evinize yaklaşıyor', sub);
    }
    return set(`${fmtMin(t.school?.etaSec)} <small>dk</small>`, 'Okula kalan süre', me.boardedAt ? `Servise bindi: ${fmtTime(me.boardedAt)}` : '');
  }
  if (!my.done) {
    const sub = my.stopsBefore > 0 ? `Sizden önce ${my.stopsBefore} öğrenci bırakılacak` : 'Sıradaki durak sizsiniz';
    return set(`${fmtMin(my.etaSec)} <small>dk</small>`, 'Öğrenciniz eve geliyor', sub);
  }
  return set('🏠', 'Servis evinize ulaştı', `Varış: ${fmtTime(my.doneAt)}`);
}

function steps(v) {
  const a = v.attendance;
  const step = (title, at, badAt, badText) => {
    if (badAt) return `<div class="step bad"><b>${title}</b>${badText} · ${fmtTime(badAt)}</div>`;
    return `<div class="step ${at ? 'ok' : ''}"><b>${title}</b>${at ? '✓ ' + fmtTime(at) : '<span class="muted">–</span>'}</div>`;
  };
  $('steps').innerHTML =
    step('Sabah · bindi', a.morning.boarded, a.morning.absent, 'Binmedi') +
    step('Sabah · okulda indi', a.morning.dropped) +
    step('Akşam · bindi', a.afternoon.boarded, a.afternoon.absent, 'Binmedi!') +
    step('Akşam · evde indi', a.afternoon.dropped);
}

function render(v) {
  view = v;
  $('content').hidden = false;
  $('student').textContent = v.student.name;
  $('busName').textContent = v.bus ? `${v.bus.name}${v.bus.plate ? ' · ' + v.bus.plate : ''}` : 'Servis atanmamış';
  $('bus').textContent = v.bus?.name || '–';
  $('plate').textContent = v.bus?.plate || '–';
  $('driver').textContent = v.bus?.driverName || '–';
  const call = $('callBtn');
  if (v.bus?.driverPhone) { call.href = `tel:${v.bus.driverPhone}`; call.style.visibility = ''; }
  else call.style.visibility = 'hidden';

  const absent = v.student.absentToday;
  $('absentBtn').textContent = absent ? '↩️ Gelecek (iptal et)' : '🙋 Bugün gelmeyecek';
  $('absentBtn').classList.toggle('absent', absent);
  if (document.activeElement !== $('notifyMin')) $('notifyMin').value = String(v.student.notifyMin ?? 5);

  etaCard(v);
  steps(v);

  $('msgs').innerHTML = v.messages.length
    ? v.messages.map((m) => `<li class="${m.urgent ? 'urgent' : ''}"><time>${fmtTime(m.at)}</time><span>${escapeHtml(m.text)}</span></li>`).join('')
    : '<li class="muted">Henüz bildirim yok.</li>';

  updateMap(v);
}

function updateMap(v) {
  if (!map) return;
  if (v.student.home && !homeMarker) homeMarker = L.marker([v.student.home.lat, v.student.home.lng], { icon: pinIcon('🏠') }).addTo(map).bindTooltip('Ev');
  if (v.school && !schoolMarker) schoolMarker = L.marker([v.school.lat, v.school.lng], { icon: pinIcon('🏫') }).addTo(map).bindTooltip(v.school.name);

  if (v.busPos) {
    const ll = [v.busPos.lat, v.busPos.lng];
    if (!busMarker) busMarker = L.marker(ll, { icon: busIcon(), zIndexOffset: 1000 }).addTo(map);
    else busMarker.setLatLng(ll);
    busMarker.setOpacity(v.busPos.stale ? 0.5 : 1);
    busMarker.bindTooltip(v.busPos.stale ? `Son konum ${fmtTime(v.busPos.at)}` : 'Servis');
  } else if (busMarker) {
    busMarker.remove();
    busMarker = null;
  }

  if (!fitted) {
    const pts = [homeMarker, schoolMarker, busMarker].filter(Boolean).map((m) => m.getLatLng());
    if (pts.length) { map.fitBounds(L.latLngBounds(pts).pad(0.2)); fitted = true; }
  }
}

function onNotify(n) {
  toast(n.text, n.urgent ? 10000 : 4000);
  if (navigator.vibrate) navigator.vibrate(n.urgent ? [400, 150, 400, 150, 400] : [200, 100, 200]);
}

// --- Telefon bildirimleri (web push) ------------------------------------
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function b64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function currentSub() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

async function renderPush() {
  const box = $('pushBox');
  if (!pushSupported) {
    box.innerHTML = isIos && !isStandalone
      ? '<div class="small">📲 iPhone\'da kilit ekranına bildirim gelmesi için: alttaki <b>Paylaş</b> düğmesine basın → <b>Ana Ekrana Ekle</b>. Sonra sayfayı ana ekrandaki simgeden açıp buraya tekrar dokunun.</div>'
      : '<div class="small muted">Bu tarayıcı telefon bildirimini desteklemiyor. Bildirimler sayfa açıkken görünür.</div>';
    return;
  }
  const sub = await currentSub();
  if (sub && Notification.permission === 'granted') {
    box.innerHTML = '<div class="small">✅ Bu telefona bildirim gelecek. <a href="#" id="pushOff">Kapat</a></div>';
    $('pushOff').onclick = async (e) => {
      e.preventDefault();
      await api('DELETE', `/api/parent/${token}/push`, { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
      renderPush();
    };
  } else if (Notification.permission === 'denied') {
    box.innerHTML = '<div class="small" style="color:var(--warn)">Bildirim izni reddedilmiş. Tarayıcı ayarlarından bu site için bildirimlere izin verin.</div>';
  } else {
    box.innerHTML = '<button class="primary" id="pushOn" style="width:100%">🔔 Telefonuma bildirim gelsin</button>';
    $('pushOn').onclick = enablePush;
  }
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return renderPush();
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.pushKey) });
    await api('POST', `/api/parent/${token}/push`, { subscription: sub.toJSON() });
    toast('Bildirimler açıldı');
  } catch (e) {
    toast('Bildirim açılamadı: ' + e.message);
  }
  renderPush();
}

// --- Geçmiş --------------------------------------------------------------
$('historyBox').addEventListener('toggle', async () => {
  if (!$('historyBox').open) return;
  const rows = await api('GET', `/api/parent/${token}/history`);
  if (!rows.length) { $('history').textContent = 'Henüz kayıt yok.'; return; }
  const cell = (t, bad) => (t.absent ? `<span style="color:var(--danger)">${bad}</span>` : `${t.boarded ? fmtTime(t.boarded) : '–'} → ${t.dropped ? fmtTime(t.dropped) : '–'}`);
  const day = (d) => new Date(d + 'T12:00:00').toLocaleDateString('tr-TR', { weekday: 'short', day: 'numeric', month: 'short' });
  $('history').innerHTML = `<table><tr><th>Gün</th><th>Sabah (bindi → indi)</th><th>Akşam</th></tr>${
    rows.map((r) => `<tr><td>${day(r.date)}</td><td>${cell(r.morning, 'Binmedi')}</td><td>${cell(r.afternoon, 'Binmedi')}</td></tr>`).join('')}</table>`;
});

// --- Ayarlar -------------------------------------------------------------
$('notifyMin').onchange = async (e) => {
  try { render(await api('POST', `/api/parent/${token}/settings`, { notifyMin: Number(e.target.value) })); toast('Kaydedildi'); }
  catch (err) { toast(err.message); }
};

$('absentBtn').onclick = async () => {
  const absent = !view.student.absentToday;
  if (absent && !confirm(`${view.student.name} bugün servise binmeyecek. Şoföre bildirilsin mi?`)) return;
  try { render(await api('POST', `/api/parent/${token}/absent`, { absent })); }
  catch (e) { toast(e.message); }
};

(async () => {
  try {
    render(await api('GET', `/api/parent/${token}`));
  } catch (e) {
    $('student').textContent = 'Bağlantı geçersiz';
    $('error').style.display = 'block';
    $('error').textContent = 'Bu bağlantı geçersiz veya yenilenmiş. Lütfen servis firmasından yeni bağlantı isteyin.';
    return;
  }
  cfg = await fetch('/api/config').then((r) => r.json());
  if (pushSupported) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  renderPush();
  try {
    map = await makeMap('map');
    updateMap(view);
  } catch { $('map').textContent = 'Harita yüklenemedi'; }
  liveStream(`/api/parent/${token}/stream`, { view: render, notify: onNotify }, setLive);
})();
