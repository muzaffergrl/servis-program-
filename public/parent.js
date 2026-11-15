const token = location.pathname.split('/').pop();
let map, busMarker, homeMarker, schoolMarker, view, fitted = false;

function setLive(ok) {
  $('live').innerHTML = ok ? '<span class="dot ok"></span> canlı' : '<span class="dot warn"></span> bağlantı bekleniyor';
}

function etaCard(v) {
  const t = v.trip;
  const card = $('eta');
  card.classList.remove('ok');
  const set = (big, label, sub = '') => { $('etaBig').innerHTML = big; $('etaLabel').textContent = label; $('etaSub').textContent = sub; };

  if (v.student.absentToday && (!t || !t.onTrip)) return set('🙋', 'Bugün servise binmeyecek olarak işaretlendi.');
  if (!t) return set('🕒', 'Servis henüz yola çıkmadı.', 'Servis yola çıkınca burada kalan süreyi göreceksiniz.');

  const morning = t.type === 'morning';
  if (t.finishedAt) {
    card.classList.add('ok');
    return morning
      ? set('✅', `Servis okula ulaştı`, `Varış: ${fmtTime(t.school?.doneAt || t.finishedAt)}`)
      : set('✅', 'Akşam servisi tamamlandı', `Bitiş: ${fmtTime(t.finishedAt)}`);
  }
  if (!t.onTrip) return set('🚌', 'Servis yolda', 'Öğrenciniz bu seferde değil.');

  const my = t.myStop;
  if (morning) {
    if (!my.done) {
      const sub = my.stopsBefore > 0 ? `Sizden önce ${my.stopsBefore} öğrenci alınacak` : 'Sıradaki durak sizsiniz';
      return set(`${fmtMin(my.etaSec)} <small>dk</small>`, 'Servis evinize yaklaşıyor', sub);
    }
    return set(`${fmtMin(t.school?.etaSec)} <small>dk</small>`, 'Servisten okula kalan süre', `Servis evinizden ${fmtTime(my.doneAt)}'de geçti`);
  }
  if (!my.done) {
    const sub = my.stopsBefore > 0 ? `Sizden önce ${my.stopsBefore} öğrenci bırakılacak` : 'Sıradaki durak sizsiniz';
    return set(`${fmtMin(my.etaSec)} <small>dk</small>`, 'Öğrenciniz eve geliyor', sub);
  }
  card.classList.add('ok');
  return set('🏠', 'Öğrenciniz evde', `Bırakılma: ${fmtTime(my.doneAt)}`);
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

  etaCard(v);

  $('msgs').innerHTML = v.messages.length
    ? v.messages.map((m) => `<li><time>${fmtTime(m.at)}</time><span>${escapeHtml(m.text)}</span></li>`).join('')
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
  toast(n.text);
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (window.Notification?.permission === 'granted') {
    try { new Notification('Servis', { body: n.text }); } catch { /* bazı mobil tarayıcılar desteklemez */ }
  }
}

$('absentBtn').onclick = async () => {
  const absent = !view.student.absentToday;
  if (absent && !confirm(`${view.student.name} bugün servise binmeyecek. Şoföre bildirilsin mi?`)) return;
  try { render(await api('POST', `/api/parent/${token}/absent`, { absent })); }
  catch (e) { toast(e.message); }
};

if (window.Notification && Notification.permission === 'default') {
  $('notifBtn').hidden = false;
  $('notifBtn').onclick = async () => { await Notification.requestPermission(); $('notifBtn').hidden = true; };
}

(async () => {
  try {
    render(await api('GET', `/api/parent/${token}`));
  } catch (e) {
    $('student').textContent = 'Bağlantı geçersiz';
    $('error').style.display = 'block';
    $('error').textContent = 'Bu bağlantı geçersiz veya yenilenmiş. Lütfen servis firmasından yeni bağlantı isteyin.';
    return;
  }
  try {
    map = await makeMap('map');
    fitted = false;
    updateMap(view);
  } catch { $('map').textContent = 'Harita yüklenemedi'; }
  liveStream(`/api/parent/${token}/stream`, { view: render, notify: onNotify }, setLive);
})();
