const token = location.pathname.split('/').pop();
let watchId = null, wakeLock = null, lastSent = 0, view = null;

function rowHtml(r, trip, etaByStudent, i) {
  const morning = trip.type === 'morning';
  const eta = etaByStudent.get(r.studentId);
  const id = r.studentId;
  let status = '', buttons = '';

  if (r.parentAbsent && !r.boardedAt) {
    status = '<span class="chip nav">Veli: gelmeyecek</span>';
  } else if (r.noLocation) {
    status = '<span class="chip warn">Ev konumu yok</span>';
  } else if (r.absentAt) {
    status = `<span class="chip bad">✕ Binmedi ${fmtTime(r.absentAt)}</span>`;
  } else if (r.droppedAt) {
    status = `<span class="chip ok">✓ İndi ${fmtTime(r.droppedAt)}</span>`;
  } else if (r.boardedAt) {
    status = `<span class="chip ok">✓ Bindi ${fmtTime(r.boardedAt)}</span>`;
    // Sabah inişler okulda toplu yapılır; akşam her evde tek tek
    if (!morning) buttons = `<button class="b-ok" data-ev="dropped" data-id="${id}">🏠 İndi</button><span></span>`;
  } else {
    status = eta != null ? `<span class="mono muted">${fmtMin(eta)} dk</span>` : '';
    buttons = `<button class="b-ok" data-ev="boarded" data-id="${id}">✓ Bindi</button>
               <button class="b-no" data-ev="absent" data-id="${id}">✕ Binmedi</button>`;
  }
  const marked = r.boardedAt || r.absentAt;
  const undo = marked && !trip.closedAt ? `<button class="undo" data-ev="undo" data-id="${id}">geri al</button>` : '';
  const off = (r.parentAbsent && !r.boardedAt) || r.noLocation || r.absentAt || r.droppedAt;
  return `<li class="${off ? 'off' : ''}">
    <div class="top"><span class="name"><span class="no">${i + 1}</span>${escapeHtml(r.name)}</span><span>${status} ${undo}</span></div>
    ${buttons ? `<div class="btns">${buttons}</div>` : ''}
  </li>`;
}

function render(v) {
  view = v;
  $('title').textContent = v.bus.name;
  $('who').textContent = v.bus.driverName ? `Şoför: ${v.bus.driverName}` : '';
  $('plateBox').innerHTML = v.bus.plate ? `<span class="plate"><b>TR</b><span>${escapeHtml(v.bus.plate)}</span></span>` : '';
  const trip = v.trip && !v.trip.closedAt ? v.trip : null;
  $('startBtns').hidden = !!trip;
  $('tripBox').hidden = !trip;
  $('counts').hidden = !trip;

  $('alarm').innerHTML = trip?.finishedAt && trip.onBoard.length
    ? `<div class="alarm">⚠️ İnişi işaretlenmemiş: ${trip.onBoard.map(escapeHtml).join(', ')}<br>Aracı kontrol edin, kimse kalmasın!</div>`
    : '';

  if (!trip) { stopGps(); return; }
  startGps();

  const morning = trip.type === 'morning';
  const rs = trip.riders;
  const n = (f) => rs.filter(f).length;
  $('counts').innerHTML = `
    <div><b>${n((r) => r.boardedAt && !r.droppedAt)}</b><span>Araçta</span></div>
    <div><b>${n((r) => !r.boardedAt && !r.absentAt && !r.parentAbsent && !r.noLocation)}</b><span>Bekleyen</span></div>
    <div><b>${n((r) => r.absentAt || (r.parentAbsent && !r.boardedAt))}</b><span>Gelmeyen</span></div>`;

  $('tripTitle').textContent = `${morning ? '🌅 Sabah turu' : '🌇 Akşam turu'} · ${rs.length} öğrenci`;
  const etaByStudent = new Map(trip.stops.filter((s) => s.kind === 'student').map((s) => [s.studentId, s.etaSec]));
  const riders = morning ? rs : [...rs].reverse();
  $('riders').innerHTML = riders.map((r, i) => rowHtml(r, trip, etaByStudent, i)).join('');

  // Sıradaki durak
  const next = trip.stops.find((s) => !s.done);
  const nc = $('nextCard');
  nc.hidden = !next;
  if (next) {
    nc.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><span class="lbl">Sıradaki durak</span><span class="eta">${next.etaSec != null && next.etaSec < 45 ? 'şimdi' : fmtMin(next.etaSec) + ' dk'}</span></div>
      <div class="nm">${next.kind === 'school' ? '🏫 ' : ''}${escapeHtml(next.name)}</div>
      <div class="ad">${next.kind === 'school' ? `Araçta ${trip.onBoard.length} öğrenci` : morning ? 'Öğrenciyi alın, "Bindi"ye basın' : 'Öğrenciyi bırakın, "İndi"ye basın'}</div>`;
  }

  const bulk = $('bulkBtn');
  if (morning) {
    bulk.hidden = !trip.onBoard.length;
    bulk.textContent = `🏫 Okula vardık – herkes indi (${trip.onBoard.length})`;
    bulk.onclick = () => act('POST', `/api/driver/${token}/school-drop`);
  } else {
    const waiting = trip.riders.filter((r) => !r.parentAbsent && !r.noLocation && !r.boardedAt && !r.absentAt);
    bulk.hidden = !waiting.length;
    bulk.textContent = `✓ Kalan herkes bindi (${waiting.length})`;
    bulk.onclick = () => confirm('Listede işaretlenmemiş herkes bindi olarak kaydedilsin mi?') && act('POST', `/api/driver/${token}/school-board`);
  }
}

async function act(method, url, body) {
  try { render(await api(method, url, body)); }
  catch (e) { toast(e.message, 6000); }
}

$('riders').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ev]');
  if (!b) return;
  const ev = b.dataset.ev;
  if (ev === 'absent' && view.trip.type === 'afternoon' && !confirm('Öğrenci okul çıkışında servise binmedi mi? Veliye acil bildirim gidecek.')) return;
  act('POST', `/api/driver/${token}/attendance`, { studentId: Number(b.dataset.id), event: ev });
});

document.querySelectorAll('[data-type]').forEach((b) => b.onclick = () => act('POST', `/api/driver/${token}/trip`, { type: b.dataset.type }));

$('endBtn').onclick = async () => {
  if (!confirm('Tur bitirilsin mi?')) return;
  try {
    render(await api('DELETE', `/api/driver/${token}/trip`));
  } catch (e) {
    if (e.status === 409) {
      // Çocuk unutma kontrolü
      if (confirm(`⚠️ ${e.message}\n\nAracı kontrol ettiniz ve kimse kalmadıysa "Tamam"a basın.`)) {
        render(await api('DELETE', `/api/driver/${token}/trip?force=1`));
      }
    } else toast(e.message);
  }
};

// --- GPS -----------------------------------------------------------------
function startGps() {
  if (watchId != null) return;
  if (!navigator.geolocation) { $('gps').textContent = 'Bu cihaz konum desteklemiyor'; return; }
  watchId = navigator.geolocation.watchPosition(async (p) => {
    $('gps').innerHTML = `<span class="dot ok"></span> Konum paylaşılıyor (±${Math.round(p.coords.accuracy)} m)`;
    if (Date.now() - lastSent < 4000) return;
    lastSent = Date.now();
    try {
      await api('POST', `/api/driver/${token}/location`, {
        lat: p.coords.latitude, lng: p.coords.longitude, speed: p.coords.speed, accuracy: p.coords.accuracy,
      });
    } catch (e) { $('gps').innerHTML = `<span class="dot warn"></span> Gönderilemedi: ${escapeHtml(e.message)}`; }
  }, (err) => { $('gps').innerHTML = `<span class="dot warn"></span> GPS hatası: ${escapeHtml(err.message)}`; },
  { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  navigator.wakeLock?.request('screen').then((l) => (wakeLock = l)).catch(() => {});
}
function stopGps() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  wakeLock?.release(); wakeLock = null;
  $('gps').innerHTML = '<span class="dot"></span> GPS kapalı';
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && watchId != null) navigator.wakeLock?.request('screen').then((l) => (wakeLock = l)).catch(() => {});
});

api('GET', `/api/driver/${token}`).then(render).catch((e) => { $('title').textContent = e.message; });
liveStream(`/api/driver/${token}/stream`, { view: render });
