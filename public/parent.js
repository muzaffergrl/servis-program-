const token = location.pathname.split('/').pop();
let map, busMarker, homeMarker, schoolMarker, view, cfg, fitted = false;

// iPhone "Ana Ekrana Ekle" için bu öğrenciye özel manifest
const mf = document.createElement('link');
mf.rel = 'manifest';
mf.href = `/v/${token}/manifest.webmanifest`;
document.head.appendChild(mf);

function setLive(ok) {
  $('live').innerHTML = ok ? '<span class="dot ok"></span> canlı' : '<span class="dot warn"></span> bağlanıyor';
}

const RING = 2 * Math.PI * 70;
let ringKey = null, ringMax = 0;
/** Halka: kalan sürenin, bu aşamanın başındaki süreye oranı */
function ring(p) {
  $('ringBar').style.strokeDashoffset = String(RING * (1 - Math.max(0, Math.min(1, p))));
}
function etaProgress(key, sec) {
  if (ringKey !== key) { ringKey = key; ringMax = sec; }
  ringMax = Math.max(ringMax, sec, 60);
  return 1 - sec / ringMax;
}

function heroCard(v) {
  const t = v.trip;
  const me = t?.me || {};
  const name = v.student.name.split(' ')[0];
  const set = (tone, big, unit, label, sub = '', p = 0) => {
    $('hero').className = `card hero ${tone}`;
    const word = typeof big === 'string' && big.length > 3;
    $('etaBig').className = 'big' + (word ? ' word' : '');
    $('etaBig').textContent = big;
    $('etaUnit').textContent = unit;
    $('etaLabel').textContent = label;
    $('etaSub').textContent = sub;
    ring(p);
  };

  if (t?.type === 'afternoon' && me.absentAt) {
    return set('alert', '!', '', `${name} okul çıkışında servise binmedi`, `Şoför ${fmtTime(me.absentAt)}'de işaretledi. Lütfen okulla iletişime geçin.`, 1);
  }
  if (v.student.absentToday && (!t || !t.onTrip)) return set('calm', 'İzinli', '', 'Bugün servise binmeyecek', 'Şoföre bildirildi. Servis evinize uğramayacak.');
  if (!t) return set('calm', '–', '', 'Servis henüz yola çıkmadı', 'Servis yola çıkınca kalan süre burada görünür.');

  const morning = t.type === 'morning';
  if (morning && me.absentAt) return set('alert', '!', '', `${name} bugün servise binmedi`, `Şoför ${fmtTime(me.absentAt)}'de işaretledi.`, 1);
  if (morning && me.droppedAt) return set('ok', 'Okulda', '', `${name} okula vardı`, `Servisten indi · ${fmtTime(me.droppedAt)}`, 1);
  if (!morning && me.droppedAt) return set('ok', 'Evde', '', `${name} eve ulaştı`, `Servisten indi · ${fmtTime(me.droppedAt)}`, 1);

  if (t.finishedAt) {
    return morning
      ? set('ok', 'Okulda', '', 'Servis okula ulaştı', `Varış ${fmtTime(t.school?.doneAt || t.finishedAt)}`, 1)
      : set('ok', '✓', '', 'Akşam servisi tamamlandı', `Bitiş ${fmtTime(t.finishedAt)}`, 1);
  }
  if (!t.onTrip) return set('calm', '–', '', 'Servis yolda', `${name} bu seferde değil.`);

  const my = t.myStop;
  const clock = (sec) => fmtTime(Date.now() + sec * 1000);
  if (morning) {
    if (!my.done) {
      if (my.etaSec != null && my.etaSec < 45) return set('', 'Kapıda', '', 'Servis kapınızda', 'Şoför bekliyor', 1);
      const sub = (my.stopsBefore > 0 ? `Sizden önce ${my.stopsBefore} öğrenci alınacak` : 'Sıradaki durak sizsiniz') + ` · ~${clock(my.etaSec)}`;
      return set('', fmtMin(my.etaSec), 'dk', 'Servis evinize geliyor', sub, etaProgress(`${t.startedAt}-home`, my.etaSec));
    }
    return set('', fmtMin(t.school?.etaSec), 'dk', `${name} serviste · okula gidiyor`,
      (me.boardedAt ? `Bindi ${fmtTime(me.boardedAt)} · ` : '') + `okula varış ~${clock(t.school?.etaSec || 0)}`, etaProgress(`${t.startedAt}-school`, t.school?.etaSec || 0));
  }
  if (!my.done) {
    const sub = (my.stopsBefore > 0 ? `Sizden önce ${my.stopsBefore} öğrenci bırakılacak` : 'Sıradaki durak sizsiniz') + ` · ~${clock(my.etaSec)}`;
    return set('', fmtMin(my.etaSec), 'dk', `${name} eve geliyor`, sub, etaProgress(`${t.startedAt}-home`, my.etaSec));
  }
  return set('ok', 'Evde', '', 'Servis evinize ulaştı', `Varış ${fmtTime(my.doneAt)}`, 1);
}

function usualLine(v) {
  const t = v.trip;
  const morningPending = !t || (t.type === 'morning' && !t.me?.boardedAt && !t.me?.absentAt);
  const u = morningPending ? v.usual?.morning : v.usual?.afternoon;
  const el = $('usual');
  if (!u || v.student.absentToday || (t && t.finishedAt)) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = morningPending ? `🕒 Servis genelde ${u.time}'de kapınızda` : `🕒 Genelde ${u.time}'de evde`;
  el.title = `Son ${u.days} günün kayıtlarından hesaplandı`;
}

function dayCard(v) {
  const a = v.attendance;
  const pt = (label, at, badAt, badText) => {
    if (badAt) return `<div class="pt bad"><i>✕</i>${badText}<span class="mono">${fmtTime(badAt)}</span></div>`;
    return `<div class="pt ${at ? 'ok' : ''}"><i>✓</i>${label}<span class="mono">${at ? fmtTime(at) : ''}</span></div>`;
  };
  $('day').innerHTML = `
    <div class="leg"><h3>🌅 Sabah</h3>${pt('Servise bindi', a.morning.boarded, a.morning.absent, 'Binmedi')}${pt('Okulda indi', a.morning.dropped)}</div>
    <div class="leg"><h3>🌇 Akşam</h3>${pt('Servise bindi', a.afternoon.boarded, a.afternoon.absent, 'Binmedi!')}${pt('Evde indi', a.afternoon.dropped)}</div>`;
}

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
function feeCard(v) {
  const f = v.fee;
  $('feeBox').hidden = !f;
  if (!f) return;
  const month = MONTHS[Number(f.month.slice(5)) - 1];
  const amount = Number(f.amount).toLocaleString('tr-TR');
  $('feeBox').innerHTML = f.paid
    ? `<span class="ico g">💳</span><div style="flex:1"><b>${month} servis ücreti</b><div class="muted small">Ödendi · ${new Date(f.paidAt).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' })}</div></div><div style="text-align:right"><div class="amt">${amount} ₺</div><span class="chip ok">Ödendi</span></div>`
    : `<span class="ico o">💳</span><div style="flex:1"><b>${month} servis ücreti</b><div class="muted small">Ödeme bilgisi için servis firmanızla görüşün</div></div><div style="text-align:right"><div class="amt">${amount} ₺</div><span class="chip warn">Bekliyor</span></div>`;
}

function render(v) {
  view = v;
  $('content').hidden = false;
  document.title = `${v.student.name} · Servis`;
  $('student').textContent = v.student.name;
  $('busMeta').innerHTML = v.bus
    ? `<span>${escapeHtml(v.bus.name)}${v.school ? ' · ' + escapeHtml(v.school.name) : ''}</span>${v.bus.plate ? `<span class="plate"><b>TR</b><span>${escapeHtml(v.bus.plate)}</span></span>` : ''}`
    : 'Servis atanmamış';
  if (v.siblings?.length) {
    $('kids').hidden = false;
    $('kids').innerHTML = `<a class="on" href="/v/${token}">${escapeHtml(v.student.name.split(' ')[0])}</a>` +
      v.siblings.map((s) => `<a href="/v/${encodeURIComponent(s.token)}">${escapeHtml(s.name.split(' ')[0])}</a>`).join('');
  }
  $('bus').textContent = v.bus?.name || '–';
  $('plate').innerHTML = v.bus?.plate ? `<span class="plate"><b>TR</b><span>${escapeHtml(v.bus.plate)}</span></span>` : '–';
  $('driver').textContent = v.bus?.driverName || '–';
  $('school').textContent = v.school?.name || '–';
  const call = $('callBtn');
  if (v.bus?.driverPhone) { call.href = `tel:${v.bus.driverPhone}`; call.style.visibility = ''; }
  else call.style.visibility = 'hidden';

  const absent = v.student.absentToday;
  $('absentText').textContent = absent ? 'Gelmeyecek · geri al' : 'Bugün gelmeyecek';
  $('absentBtn').classList.toggle('on', absent);
  if (document.activeElement !== $('notifyMin')) $('notifyMin').value = String(v.student.notifyMin ?? 5);

  heroCard(v);
  usualLine(v);
  dayCard(v);
  feeCard(v);

  const ann = v.announcements?.[0];
  $('ann').hidden = !ann;
  if (ann) {
    $('annText').textContent = ann.text;
    $('annTime').textContent = new Date(ann.created_at).toLocaleString('tr-TR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  }

  $('msgs').innerHTML = v.messages.length
    ? v.messages.map((m) => `<li class="${m.urgent ? 'urgent' : ''}"><time>${fmtTime(m.at)}</time><span>${escapeHtml(m.text)}</span></li>`).join('')
    : '<li class="muted">Henüz bildirim yok.</li>';

  $('mapNote').textContent = v.busPos?.stale ? `Son konum ${fmtTime(v.busPos.at)}` : '';
  updateMap(v);
}

function updateMap(v) {
  if (!map) return;
  if (v.student.home && !homeMarker) homeMarker = map.marker([v.student.home.lat, v.student.home.lng], { emoji: '🏠', title: 'Ev' });
  if (v.school && !schoolMarker) schoolMarker = map.marker([v.school.lat, v.school.lng], { emoji: '🏫', title: v.school.name });

  if (v.busPos) {
    const ll = [v.busPos.lat, v.busPos.lng];
    if (!busMarker) busMarker = map.marker(ll, { kind: 'bus', z: 1000 });
    else busMarker.setPos(ll);
    busMarker.setOpacity(v.busPos.stale ? 0.5 : 1);
    busMarker.setTitle(v.busPos.stale ? `Son konum ${fmtTime(v.busPos.at)}` : 'Servis');
  } else if (busMarker) {
    busMarker.remove();
    busMarker = null;
  }

  if (!fitted) {
    const pts = [homeMarker, schoolMarker, busMarker].filter(Boolean).map((m) => m.pos());
    if (pts.length) { map.fit(pts); fitted = true; }
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
    box.innerHTML = '<button class="navy" id="pushOn" style="width:100%;padding:13px">🔔 Telefonuma bildirim gelsin</button>';
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
  const cell = (t, bad) => (t.absent ? `<span class="chip bad">${bad}</span>` : t.boarded ? `<span class="mono">${fmtTime(t.boarded)} → ${t.dropped ? fmtTime(t.dropped) : '–'}</span>` : '<span class="muted">–</span>');
  const day = (d) => new Date(d + 'T12:00:00').toLocaleDateString('tr-TR', { weekday: 'short', day: 'numeric', month: 'short' });
  $('history').innerHTML = `<table class="hist"><tr><th>Gün</th><th>Sabah (bindi → indi)</th><th>Akşam</th></tr>${
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
  cfg = await getConfig();
  if (pushSupported) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  renderPush();
  try {
    map = await makeMap('map');
    updateMap(view);
  } catch { $('map').textContent = 'Harita yüklenemedi'; }
  liveStream(`/api/parent/${token}/stream`, { view: render, notify: onNotify }, setLive);
})();
