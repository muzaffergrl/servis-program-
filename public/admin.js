let S = { schools: [], buses: [], students: [] };
let me = null, companyId = null;
let liveMap, pickMap, schoolMap, pickMarker, schoolPickMarker;
const busMarkers = new Map();
const origin = location.origin;

const parentLink = (s) => `${origin}/v/${s.parent_token}`;
const driverLink = (b) => `${origin}/d/${b.driver_token}`;
const busName = (id) => S.buses.find((b) => b.id === id)?.name || '—';
const schoolName = (id) => S.schools.find((s) => s.id === id)?.name || '—';

function waLink(phone, text) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '90' + p.slice(1);
  else if (p.length === 10) p = '90' + p;
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Bağlantı kopyalandı'); }
  catch { prompt('Kopyalayın:', text); }
}

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* gizli sekme */ } },
};

// --- Sekmeler ------------------------------------------------------------
function showTab(name) {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('active', s.id === `tab-${name}`));
  setTimeout(() => [liveMap, pickMap, schoolMap].forEach((m) => m?.resize()), 50);
  if (name === 'attendance') loadAttendance();
  if (name === 'companies') loadCompanies();
  if (name === 'announce') loadAnnouncements();
  if (name === 'payments') loadPayments();
  if (name === 'documents') loadDocuments();
}
document.querySelectorAll('nav button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));

// --- Çizim ---------------------------------------------------------------
function render() {
  renderSelects();
  renderLive();
  renderBuses();
  renderStudents();
  renderSchools();
}

function renderSelects() {
  const schoolOpts = '<option value="">—</option>' + S.schools.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  const busOpts = '<option value="">—</option>' + S.buses.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  document.querySelectorAll('.schoolSelect').forEach((el) => { const v = el.value; el.innerHTML = schoolOpts; el.value = v; });
  document.querySelectorAll('.busSelect').forEach((el) => { const v = el.value; el.innerHTML = busOpts; el.value = v; });
  const av = $('annBus').value;
  $('annBus').innerHTML = '<option value="">Tüm veliler (bütün servisler)</option>' + S.buses.map((b) => `<option value="${b.id}">${escapeHtml(b.name)} velileri</option>`).join('');
  $('annBus').value = av;
  for (const f of [$('studentFilter'), $('attBus'), $('payBus')]) {
    const fv = f.value;
    f.innerHTML = '<option value="">Tümü</option>' + S.buses.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
    f.value = fv;
  }
}

const plateHtml = (p) => (p ? `<span class="plate"><b>TR</b><span>${escapeHtml(p)}</span></span>` : '');
const daysLeft = (d) => Math.round((new Date(d + 'T12:00:00') - new Date(S.today + 'T12:00:00')) / 86400_000);

function renderLive() {
  // Özet kutuları
  const open = S.buses.filter((b) => b.live.trip && !b.live.trip.closedAt);
  const riders = open.flatMap((b) => b.live.trip.riders);
  const onBoard = riders.filter((r) => r.boardedAt && !r.droppedAt).length;
  const absentToday = S.students.filter((s) => s.absent_on === S.today).length + riders.filter((r) => r.absentAt).length;
  const alarms = open.filter((b) => b.live.trip.finishedAt && b.live.trip.onBoard.length).length;
  const docs = S.docAlerts || [];
  $('kpis').innerHTML = `
    <div class="kpi"><span class="ico g">🚌</span><div><div class="v">${open.length}<span class="muted" style="font-size:1rem"> / ${S.buses.length}</span></div><div class="k">Yoldaki servis</div></div></div>
    <div class="kpi"><span class="ico y">🎒</span><div><div class="v">${onBoard}</div><div class="k">Şu an serviste</div></div></div>
    <div class="kpi"><span class="ico b">👪</span><div><div class="v">${S.students.length}</div><div class="k">Toplam öğrenci</div></div></div>
    <div class="kpi"><span class="ico o">🙋</span><div><div class="v">${absentToday}</div><div class="k">Bugün gelmeyen</div></div></div>
    <div class="kpi ${alarms ? 'alert' : ''}"><span class="ico ${docs.length ? 'r' : 't'}">${alarms ? '⚠️' : '📄'}</span><div><div class="v">${alarms || docs.length}</div><div class="k">${alarms ? 'Araçta unutulan!' : 'Belge uyarısı'}</div></div></div>`;
  $('docBadge').hidden = !docs.length;
  $('docBadge').textContent = docs.length;
  $('docAlerts').innerHTML = docs.map((d) => {
    const n = daysLeft(d.expires_on);
    return `<div class="doc-alert ${n < 0 ? 'exp' : ''}"><span>${n < 0 ? '⛔' : '⏳'}</span><div><b>${escapeHtml(d.bus_name || 'Genel')}: ${escapeHtml(d.kind)}</b><div class="small">${n < 0 ? `${-n} gün önce bitti` : n === 0 ? 'Bugün bitiyor' : `${n} gün kaldı`} · ${new Date(d.expires_on + 'T12:00:00').toLocaleDateString('tr-TR')}</div></div></div>`;
  }).join('');

  $('liveList').innerHTML = S.buses.map((b) => {
    const t = b.live.trip;
    const isOpen = t && !t.closedAt;
    const status = isOpen
      ? `<span class="dot ok"></span> ${t.type === 'morning' ? 'Sabah turu' : 'Akşam turu'}${t.finishedAt ? ' · duraklar bitti' : ''}${b.simulating ? ' · simülasyon' : ''}`
      : t?.closedAt ? `<span class="dot"></span> Tur bitti ${fmtTime(t.closedAt)}` : '<span class="dot"></span> Beklemede';
    const riderMap = new Map((t?.riders || []).map((r) => [r.studentId, r]));
    const att = (st) => {
      const r = riderMap.get(st.studentId);
      if (!r) return null;
      if (r.absentAt) return '<span class="chip bad">binmedi</span>';
      if (r.droppedAt) return '<span class="chip ok">indi</span>';
      if (r.boardedAt) return '<span class="chip ok">bindi</span>';
      return null;
    };
    const stops = isOpen && !t.finishedAt
      ? `<ul class="stops">${t.stops.map((st, i) => `<li class="${st.done ? 'done' : ''}"><span class="n">${st.done ? '✓' : st.kind === 'school' ? 'O' : i + 1}</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(st.name)}</span>${att(st) || (st.done ? `<span class="mono muted small">${fmtTime(st.doneAt)}</span>` : `<span class="e">${fmtMin(st.etaSec)} dk</span>`)}</li>`).join('')}</ul>`
      : '';
    const alarm = isOpen && t.finishedAt && t.onBoard.length
      ? `<div class="alarm">⚠️ İnişi işaretlenmemiş: ${t.onBoard.map(escapeHtml).join(', ')}</div>` : '';
    const stale = isOpen && !t.finishedAt && b.live.pos?.stale ? '<div class="chip warn" style="margin-top:6px">⚠️ Konum 2 dakikadır gelmiyor</div>' : '';
    const count = S.students.filter((s) => s.bus_id === b.id).length;
    return `<div class="card bus-card ${isOpen ? 'live' : ''}">
      <div class="hd"><h3>${escapeHtml(b.name)}</h3>${plateHtml(b.plate)}</div>
      <div class="muted small">${escapeHtml(b.driver_name || 'Şoför girilmemiş')} · ${count} öğrenci</div>
      <div class="status">${status}</div>${alarm}${stale}${stops}
      <div class="btns" style="margin-top:10px">
        ${isOpen
          ? `<button data-act="end" data-id="${b.id}">⏹ Turu bitir</button>`
          : `<button data-act="sim" data-type="morning" data-id="${b.id}">▶ Sabah simülasyonu</button>
             <button data-act="sim" data-type="afternoon" data-id="${b.id}">▶ Akşam simülasyonu</button>`}
      </div></div>`;
  }).join('') || '<p class="muted">Henüz servis yok.</p>';

  if (!liveMap) return;
  for (const b of S.buses) {
    const p = b.live.pos;
    let m = busMarkers.get(b.id);
    if (!p) { m?.remove(); busMarkers.delete(b.id); continue; }
    if (!m) { m = liveMap.marker([p.lat, p.lng], { kind: 'bus', title: b.name }); busMarkers.set(b.id, m); }
    m.setPos([p.lat, p.lng]);
    m.setOpacity(p.stale ? 0.5 : 1);
  }
  for (const [id, m] of busMarkers) if (!S.buses.some((b) => b.id === id)) { m.remove(); busMarkers.delete(id); }
}

function renderBuses() {
  $('busTable').innerHTML = `<tr><th>Servis</th><th>Plaka</th><th>Şoför</th><th>Okul</th><th>Öğrenci</th><th></th></tr>` +
    S.buses.map((b) => `<tr>
      <td><b>${escapeHtml(b.name)}</b></td><td>${plateHtml(b.plate)}</td>
      <td>${escapeHtml(b.driver_name || '')}<div class="muted small">${escapeHtml(b.driver_phone || '')}</div></td>
      <td>${escapeHtml(schoolName(b.school_id))}</td>
      <td>${S.students.filter((s) => s.bus_id === b.id).length}</td>
      <td class="btns">
        <button data-act="editBus" data-id="${b.id}">Düzenle</button>
        <button data-act="copyDriver" data-id="${b.id}">Şoför linki</button>
        ${b.driver_phone ? `<a class="btn" target="_blank" href="${waLink(b.driver_phone, `Servis şoför ekranınız: ${driverLink(b)}`)}">WhatsApp</a>` : ''}
        <button data-act="delBus" data-id="${b.id}" class="danger">Sil</button>
      </td></tr>`).join('');
}

function renderStudents() {
  const filter = Number($('studentFilter').value) || null;
  const list = S.students.filter((s) => !filter || s.bus_id === filter);
  $('studentTable').innerHTML = `<tr><th>Sıra</th><th>Öğrenci</th><th>Servis</th><th>Veli</th><th>Ücret</th><th>Konum</th><th></th></tr>` +
    list.map((s) => `<tr>
      <td>${s.stop_order}</td>
      <td><b>${escapeHtml(s.name)}</b>${s.absent_on === S.today ? '<div><span class="chip warn">bugün gelmeyecek</span></div>' : ''}</td>
      <td>${escapeHtml(busName(s.bus_id))}</td>
      <td>${escapeHtml(s.parent_name || '')}<div class="muted small">${escapeHtml(s.parent_phone || '')}</div></td>
      <td class="mono">${s.monthly_fee ? Number(s.monthly_fee).toLocaleString('tr-TR') + ' ₺' : '<span class="muted">–</span>'}</td>
      <td>${s.lat != null ? '<span class="chip ok">var</span>' : '<span class="chip bad">yok</span>'}</td>
      <td class="btns">
        <button data-act="editStudent" data-id="${s.id}">Düzenle</button>
        <button data-act="copyParent" data-id="${s.id}">Veli linki</button>
        <a class="btn" target="_blank" href="${parentLink(s)}">Aç</a>
        ${s.parent_phone ? `<a class="btn" target="_blank" href="${waLink(s.parent_phone, `${s.name} için servis takip bağlantınız: ${parentLink(s)}`)}">WhatsApp</a>` : ''}
        <button data-act="newLink" data-id="${s.id}">Linki yenile</button>
        <button data-act="delStudent" data-id="${s.id}" class="danger">Sil</button>
      </td></tr>`).join('');
}

function renderSchools() {
  $('schoolTable').innerHTML = `<tr><th>Okul</th><th>Konum</th><th></th></tr>` +
    S.schools.map((s) => `<tr><td>${escapeHtml(s.name)}</td><td class="small muted">${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</td>
      <td class="btns"><button data-act="editSchool" data-id="${s.id}">Düzenle</button>
      <button data-act="delSchool" data-id="${s.id}" class="danger">Sil</button></td></tr>`).join('');
}

// --- Yoklama raporu -------------------------------------------------------
async function loadAttendance() {
  if (!companyId) return;
  const date = $('attDate').value;
  const data = await api('GET', `/api/admin/attendance?date=${encodeURIComponent(date)}`);
  const bus = Number($('attBus').value) || null;
  const isToday = data.date === new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
  const cell = (t, parentAbsent) => {
    if (t.absent) return '<span class="bad">Binmedi</span>';
    if (t.boarded && !t.dropped) {
      // Bugün tur sürüyor olabilir; geçmiş günlerde inişin işaretlenmemesi hatadır
      return isToday ? `<span style="color:var(--warn)">${fmtTime(t.boarded)} → araçta</span>` : `<span class="bad">${fmtTime(t.boarded)} → iniş işaretlenmemiş</span>`;
    }
    if (t.boarded) return `<span class="ok">${fmtTime(t.boarded)} → ${fmtTime(t.dropped)}</span>`;
    return parentAbsent ? '<span class="muted">Veli: gelmeyecek</span>' : '<span class="muted">–</span>';
  };
  const rows = data.students.filter((s) => !bus || s.bus_id === bus);
  const cnt = (f) => rows.filter(f).length;
  $('attSum').innerHTML = `
    <div class="kpi"><span class="ico g">✅</span><div><div class="v">${cnt((s) => s.morning.boarded)}</div><div class="k">Sabah bindi</div></div></div>
    <div class="kpi"><span class="ico r">✕</span><div><div class="v">${cnt((s) => s.morning.absent || s.afternoon.absent)}</div><div class="k">Binmedi</div></div></div>
    <div class="kpi"><span class="ico o">🙋</span><div><div class="v">${cnt((s) => s.parentAbsent)}</div><div class="k">Veli: gelmeyecek</div></div></div>
    <div class="kpi"><span class="ico b">🌇</span><div><div class="v">${cnt((s) => s.afternoon.dropped)}</div><div class="k">Akşam evde indi</div></div></div>`;
  $('attTable').innerHTML = `<tr><th>Öğrenci</th><th>Servis</th><th>Sabah (bindi → indi)</th><th>Akşam (bindi → indi)</th></tr>` +
    (rows.map((s) => `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(busName(s.bus_id))}</td>
      <td>${cell(s.morning, s.parentAbsent)}</td><td>${cell(s.afternoon, s.parentAbsent)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="muted">Kayıt yok</td></tr>');
}
$('attDate').onchange = loadAttendance;
$('attBus').onchange = loadAttendance;

// --- Duyurular --------------------------------------------------------------
async function loadAnnouncements() {
  if (!companyId) return;
  const list = await api('GET', '/api/admin/announcements');
  $('annList').innerHTML = list.map((a) => `<div class="ann-item"><span class="ico v">📢</span><div style="flex:1;min-width:0">
      <div>${escapeHtml(a.text)}</div>
      <div class="muted small">${new Date(a.created_at).toLocaleString('tr-TR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} · ${a.bus_name ? escapeHtml(a.bus_name) + ' velileri' : 'Tüm veliler'}</div></div>
      <button class="danger" data-act="delAnn" data-id="${a.id}" style="padding:6px 10px;font-size:.8rem">Sil</button></div>`).join('')
    || '<p class="muted">Henüz duyuru gönderilmedi.</p>';
}
$('annForm').onsubmit = async (e) => {
  e.preventDefault();
  const data = formData(e.target);
  if (!confirm(`${data.bus_id ? busName(Number(data.bus_id)) + ' velilerine' : 'Tüm velilere'} duyuru gönderilsin mi?`)) return;
  try {
    const r = await api('POST', '/api/admin/announcements', data);
    toast(`Duyuru ${r.sent} veliye gönderildi`);
    e.target.reset();
    loadAnnouncements();
  } catch (err) { toast(err.message); }
};

// --- Aidat ------------------------------------------------------------------
const MONTHS_TR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
async function loadPayments() {
  if (!companyId) return;
  const data = await api('GET', `/api/admin/payments?month=${encodeURIComponent($('payMonth').value)}`);
  const bus = Number($('payBus').value) || null;
  const rows = data.rows.filter((r) => !bus || r.bus_id === bus);
  const withFee = rows.filter((r) => r.monthly_fee || r.amount);
  const paid = withFee.filter((r) => r.payment_id);
  const total = withFee.reduce((a, r) => a + (r.amount || r.monthly_fee || 0), 0);
  const got = paid.reduce((a, r) => a + r.amount, 0);
  const tl = (n) => Number(n).toLocaleString('tr-TR') + ' ₺';
  const pct = total ? Math.round((got / total) * 100) : 0;
  $('paySum').innerHTML = `
    <div class="kpi"><span class="ico g">💳</span><div style="flex:1"><div class="v">${tl(got)}</div><div class="k">Tahsil edilen · %${pct}</div><div class="bar"><i style="width:${pct}%"></i></div></div></div>
    <div class="kpi"><span class="ico o">⏳</span><div><div class="v">${tl(total - got)}</div><div class="k">Bekleyen · ${withFee.length - paid.length} öğrenci</div></div></div>
    <div class="kpi"><span class="ico b">📅</span><div><div class="v">${MONTHS_TR[Number(data.month.slice(5)) - 1]}</div><div class="k">${data.month.slice(0, 4)}</div></div></div>`;
  $('payTable').innerHTML = `<tr><th>Öğrenci</th><th>Servis</th><th>Veli</th><th>Tutar</th><th>Durum</th><th></th></tr>` +
    (rows.map((r) => {
      const amount = r.amount || r.monthly_fee;
      const state = r.payment_id
        ? `<span class="chip ok">Ödendi · ${new Date(r.paid_at).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })}</span>`
        : amount ? '<span class="chip warn">Bekliyor</span>' : '<span class="muted small">Ücret girilmemiş</span>';
      const btn = r.payment_id
        ? `<button data-act="unpay" data-id="${r.payment_id}">Geri al</button>`
        : amount ? `<button class="okb" data-act="pay" data-id="${r.student_id}">✓ Ödendi</button>` : '';
      const wa = !r.payment_id && amount && r.parent_phone
        ? `<a class="btn" target="_blank" href="${waLink(r.parent_phone, `Merhaba, ${r.name} için ${MONTHS_TR[Number(data.month.slice(5)) - 1]} ayı servis ücreti (${tl(amount)}) henüz görünmüyor. Bilginize.`)}">Hatırlat</a>` : '';
      return `<tr><td><b>${escapeHtml(r.name)}</b></td><td>${escapeHtml(busName(r.bus_id))}</td>
        <td>${escapeHtml(r.parent_name || '')}<div class="muted small">${escapeHtml(r.parent_phone || '')}</div></td>
        <td class="mono">${amount ? tl(amount) : '–'}</td><td>${state}</td><td class="btns">${btn}${wa}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">Öğrenci yok</td></tr>');
}
$('payMonth').onchange = loadPayments;
$('payBus').onchange = loadPayments;

// --- Belgeler -----------------------------------------------------------------
async function loadDocuments() {
  if (!companyId) return;
  const list = await api('GET', '/api/admin/documents');
  loadDocuments.list = list;
  $('docTable').innerHTML = `<tr><th>Servis</th><th>Belge</th><th>Bitiş</th><th>Durum</th><th></th></tr>` +
    (list.map((d) => {
      const n = daysLeft(d.expires_on);
      const chip = n < 0 ? `<span class="chip bad">${-n} gün geçti</span>` : n <= 30 ? `<span class="chip warn">${n} gün kaldı</span>` : `<span class="chip ok">${n} gün</span>`;
      return `<tr><td>${escapeHtml(d.bus_name || 'Genel')}</td><td><b>${escapeHtml(d.kind)}</b>${d.note ? `<div class="muted small">${escapeHtml(d.note)}</div>` : ''}</td>
        <td class="mono">${new Date(d.expires_on + 'T12:00:00').toLocaleDateString('tr-TR')}</td><td>${chip}</td>
        <td class="btns"><button data-act="editDoc" data-id="${d.id}">Düzenle</button><button class="danger" data-act="delDoc" data-id="${d.id}">Sil</button></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">Henüz belge eklenmedi.</td></tr>');
}

// --- Firmalar (süper yönetici) ------------------------------------------
async function loadCompanies() {
  if (!me?.user.isSuper) return;
  const list = await api('GET', '/api/admin/companies');
  $('companyTable').innerHTML = `<tr><th>Firma</th><th>Kullanıcı</th><th>Servis</th><th>Öğrenci</th><th>Durum</th><th></th></tr>` +
    list.map((c) => `<tr>
      <td>${escapeHtml(c.name)}<div class="muted small">${escapeHtml(c.phone || '')}</div></td>
      <td>${escapeHtml(c.usernames || '')}</td><td>${c.bus_count}</td><td>${c.student_count}</td>
      <td>${c.active ? '<span class="ok">Aktif</span>' : '<span class="bad">Pasif</span>'}</td>
      <td class="btns">
        <button data-act="openCompany" data-id="${c.id}">Paneline geç</button>
        <button data-act="editCompany" data-id="${c.id}">Düzenle</button>
        <button data-act="delCompany" data-id="${c.id}" class="danger">Sil</button>
      </td></tr>`).join('');
  loadCompanies.list = list;
}

// --- Formlar -------------------------------------------------------------
function fillForm(form, obj) {
  for (const el of form.elements) if (el.name) el.value = obj[el.name] ?? '';
}
const formData = (form) => Object.fromEntries(new FormData(form));

function setupForm(formId, url, titleEl, newTitle, onReset, after = load) {
  const form = $(formId);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = formData(form);
    try {
      if (data.id) await api('PUT', `${url}/${data.id}`, data);
      else await api('POST', url, data);
      toast('Kaydedildi');
      form.querySelector('[data-reset]').click();
      await after();
    } catch (err) { toast(err.message); }
  };
  form.querySelector('[data-reset]').onclick = () => { form.reset(); form.elements.id.value = ''; $(titleEl).textContent = newTitle; onReset?.(); };
  return form;
}
const busForm = setupForm('busForm', '/api/admin/buses', 'busFormTitle', 'Yeni servis');
const studentForm = setupForm('studentForm', '/api/admin/students', 'studentFormTitle', 'Yeni öğrenci', () => { pickMarker?.remove(); pickMarker = null; });
const docForm = setupForm('docForm', '/api/admin/documents', 'docFormTitle', 'Yeni belge', null, async () => { await loadDocuments(); await load(); });
const schoolForm = setupForm('schoolForm', '/api/admin/schools', 'schoolFormTitle', 'Yeni okul', () => { schoolPickMarker?.remove(); schoolPickMarker = null; });
const companyForm = setupForm('companyForm', '/api/admin/companies', 'companyFormTitle', 'Yeni firma', () => {
  companyForm.elements.username.disabled = false;
  $('companyHint').textContent = 'Firma, bu kullanıcı adı ve şifreyle /login adresinden kendi paneline girer.';
}, async () => { await loadCompanies(); await loadMe(); });

function setPick(map, form, markerRef, lat, lng, emoji) {
  form.elements.lat.value = lat.toFixed(6);
  form.elements.lng.value = lng.toFixed(6);
  let m = markerRef();
  if (!m) m = map.marker([lat, lng], { emoji });
  else m.setPos([lat, lng]);
  return m;
}

// --- Butonlar ------------------------------------------------------------
document.body.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const bus = S.buses.find((b) => b.id === id);
  const student = S.students.find((s) => s.id === id);
  const school = S.schools.find((s) => s.id === id);
  try {
    switch (btn.dataset.act) {
      case 'sim':
        await api('POST', `/api/admin/buses/${id}/simulate`, { type: btn.dataset.type });
        break;
      case 'end':
        try { await api('DELETE', `/api/admin/buses/${id}/trip`); }
        catch (err) {
          if (err.status !== 409) throw err;
          if (!confirm(`⚠️ ${err.message}\n\nYine de bitirilsin mi?`)) return;
          await api('DELETE', `/api/admin/buses/${id}/trip?force=1`);
        }
        break;
      case 'editBus':
        fillForm(busForm, bus); $('busFormTitle').textContent = 'Servisi düzenle';
        return;
      case 'copyDriver': return copy(driverLink(bus));
      case 'delBus':
        if (!confirm(`${bus.name} silinsin mi? Öğrenciler servissiz kalır.`)) return;
        await api('DELETE', `/api/admin/buses/${id}`);
        break;
      case 'editStudent':
        fillForm(studentForm, student); $('studentFormTitle').textContent = 'Öğrenciyi düzenle';
        if (student.lat != null) {
          pickMarker = setPick(pickMap, studentForm, () => pickMarker, student.lat, student.lng, '🏠');
          pickMap.setView([student.lat, student.lng], 16);
        } else { pickMarker?.remove(); pickMarker = null; }
        studentForm.scrollIntoView({ behavior: 'smooth' });
        return;
      case 'copyParent': return copy(parentLink(student));
      case 'newLink':
        if (!confirm('Eski link çalışmaz hale gelecek. Devam edilsin mi?')) return;
        await api('POST', `/api/admin/students/${id}/new-link`);
        break;
      case 'delStudent':
        if (!confirm(`${student.name} silinsin mi?`)) return;
        await api('DELETE', `/api/admin/students/${id}`);
        break;
      case 'editSchool':
        fillForm(schoolForm, school); $('schoolFormTitle').textContent = 'Okulu düzenle';
        schoolPickMarker = setPick(schoolMap, schoolForm, () => schoolPickMarker, school.lat, school.lng, '🏫');
        schoolMap.setView([school.lat, school.lng], 16);
        return;
      case 'delSchool':
        if (!confirm(`${school.name} silinsin mi?`)) return;
        await api('DELETE', `/api/admin/schools/${id}`);
        break;
      case 'delAnn':
        if (!confirm('Duyuru veli ekranlarından kaldırılsın mı?')) return;
        await api('DELETE', `/api/admin/announcements/${id}`);
        return loadAnnouncements();
      case 'pay':
        await api('POST', '/api/admin/payments', { student_id: id, month: $('payMonth').value });
        return loadPayments();
      case 'unpay':
        await api('DELETE', `/api/admin/payments/${id}`);
        return loadPayments();
      case 'editDoc':
        fillForm(docForm, loadDocuments.list.find((d) => d.id === id));
        $('docFormTitle').textContent = 'Belgeyi düzenle';
        return;
      case 'delDoc':
        if (!confirm('Belge silinsin mi?')) return;
        await api('DELETE', `/api/admin/documents/${id}`);
        await loadDocuments();
        break;
      case 'openCompany':
        store.set('companyId', String(id));
        location.reload();
        return;
      case 'editCompany': {
        const c = loadCompanies.list.find((x) => x.id === id);
        fillForm(companyForm, { ...c, active: c.active ? '1' : '0', username: c.usernames, password: '' });
        companyForm.elements.username.disabled = true;
        $('companyHint').textContent = 'Şifre alanını boş bırakırsanız şifre değişmez.';
        $('companyFormTitle').textContent = 'Firmayı düzenle';
        return;
      }
      case 'delCompany': {
        const c = loadCompanies.list.find((x) => x.id === id);
        if (prompt(`"${c.name}" firması ve TÜM servis, öğrenci, yoklama kayıtları silinecek. Onaylamak için firma adını yazın:`) !== c.name) return;
        await api('DELETE', `/api/admin/companies/${id}`);
        if (String(id) === store.get('companyId')) { store.set('companyId', ''); location.reload(); return; }
        await loadCompanies(); await loadMe();
        return;
      }
    }
    await load();
  } catch (err) { toast(err.message); }
});

$('studentFilter').onchange = renderStudents;

$('logoutBtn').onclick = async () => { await api('POST', '/api/logout'); location.href = '/login'; };
$('pwBtn').onclick = async () => {
  const current = prompt('Mevcut şifreniz:');
  if (!current) return;
  const password = prompt('Yeni şifre (en az 6 karakter):');
  if (!password) return;
  try { await api('POST', '/api/admin/password', { current, password }); toast('Şifre değiştirildi'); }
  catch (e) { toast(e.message); }
};

// --- Başlangıç -----------------------------------------------------------
async function load() {
  if (!companyId) return;
  S = await api('GET', '/api/admin/state');
  render();
}

async function loadMe() {
  me = await api('GET', '/api/admin/me');
  $('who').textContent = me.user.isSuper ? `${me.user.username} · süper yönetici` : me.user.companyName || me.user.username;
  if (me.user.isSuper) {
    $('companiesTab').hidden = false;
    const sel = $('companySelect');
    sel.hidden = false;
    const saved = Number(store.get('companyId')) || null;
    companyId = me.companies.some((c) => c.id === saved) ? saved : null;
    sel.innerHTML = '<option value="">— Firma seçin —</option>' + me.companies.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${c.active ? '' : ' (pasif)'}</option>`).join('');
    sel.value = companyId ?? '';
    sel.onchange = () => { store.set('companyId', sel.value); location.reload(); };
    if (companyId) apiHeaders['X-Company-Id'] = String(companyId);
  } else {
    companyId = true; // firma kullanıcısı: sunucu kendi firmasını kullanır
  }
}

(async () => {
  $('attDate').value = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
  $('payMonth').value = $('attDate').value.slice(0, 7);
  await loadMe();
  if (!companyId) {
    $('noCompany').style.display = 'block';
    showTab('companies');
    return;
  }
  await load();
  const center = S.schools[0] ? [S.schools[0].lat, S.schools[0].lng] : [41.0255, 29.096];
  [liveMap, pickMap, schoolMap] = await Promise.all([makeMap('liveMap', center, 13), makeMap('pickMap', center, 13), makeMap('schoolMap', center, 13)]);
  for (const s of S.schools) liveMap.marker([s.lat, s.lng], { emoji: '🏫', title: s.name });
  pickMap.onClick((lat, lng) => { pickMarker = setPick(pickMap, studentForm, () => pickMarker, lat, lng, '🏠'); });
  schoolMap.onClick((lat, lng) => { schoolPickMarker = setPick(schoolMap, schoolForm, () => schoolPickMarker, lat, lng, '🏫'); });

  // Google varsa adres yazarak konum bulma
  const hint = 'Adresi yazıp listeden seçin; gerekirse haritaya tıklayarak tam yeri düzeltin.';
  addressSearch($('studentSearch'), (lat, lng, addr) => {
    pickMarker = setPick(pickMap, studentForm, () => pickMarker, lat, lng, '🏠');
    pickMap.setView([lat, lng], 17);
    if (addr) studentForm.elements.address.value = addr;
  }, center).then((ok) => { if (ok) $('studentPickHint').textContent = hint; }).catch(() => {});
  addressSearch($('schoolSearch'), (lat, lng, addr) => {
    schoolPickMarker = setPick(schoolMap, schoolForm, () => schoolPickMarker, lat, lng, '🏫');
    schoolMap.setView([lat, lng], 17);
    if (addr && !schoolForm.elements.name.value) schoolForm.elements.name.value = addr.split(',')[0];
  }, center).then((ok) => { if (ok) $('schoolPickHint').textContent = hint; }).catch(() => {});
  renderLive();
  const q = me.user.isSuper ? `?company=${companyId}` : '';
  liveStream(`/api/admin/stream${q}`, { state: (st) => { S = st; renderLive(); } });
})();
