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
  for (const f of [$('studentFilter'), $('attBus')]) {
    const fv = f.value;
    f.innerHTML = '<option value="">Tümü</option>' + S.buses.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
    f.value = fv;
  }
}

function renderLive() {
  $('liveList').innerHTML = S.buses.map((b) => {
    const t = b.live.trip;
    const open = t && !t.closedAt;
    const status = open
      ? `<span class="dot ok"></span> ${t.type === 'morning' ? 'Sabah turu' : 'Akşam turu'}${t.finishedAt ? ' (duraklar bitti)' : ''}${b.simulating ? ' · simülasyon' : ''}`
      : t?.closedAt ? `<span class="dot"></span> Tur bitti ${fmtTime(t.closedAt)}` : '<span class="dot"></span> Beklemede';
    const riders = new Map((t?.riders || []).map((r) => [r.studentId, r]));
    const att = (s) => {
      const r = riders.get(s.studentId);
      if (!r) return '';
      if (r.absentAt) return ' <span class="bad">binmedi</span>';
      if (r.droppedAt) return ' <span class="ok">indi</span>';
      if (r.boardedAt) return ' <span class="ok">bindi</span>';
      return '';
    };
    const stops = open && !t.finishedAt
      ? `<ol>${t.stops.map((s) => `<li class="${s.done ? 'done' : ''}">${escapeHtml(s.name)} — ${s.done ? fmtTime(s.doneAt) : fmtMin(s.etaSec) + ' dk'}${att(s)}</li>`).join('')}</ol>`
      : '';
    const alarm = open && t.finishedAt && t.onBoard.length
      ? `<div class="alarm">⚠️ İnişi işaretlenmemiş: ${t.onBoard.map(escapeHtml).join(', ')}</div>` : '';
    const stale = open && !t.finishedAt && b.live.pos?.stale ? '<div class="small" style="color:var(--warn)">⚠️ Konum 2 dakikadır gelmiyor</div>' : '';
    return `<div class="card bus-card">
      <b>${escapeHtml(b.name)}</b> <span class="muted small">${escapeHtml(b.plate || '')}</span>
      <div class="small">${status}</div>${alarm}${stale}${stops}
      <div class="btns" style="margin-top:8px">
        ${open
          ? `<button data-act="end" data-id="${b.id}">Turu bitir</button>`
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
      <td>${escapeHtml(b.name)}</td><td>${escapeHtml(b.plate || '')}</td>
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
  $('studentTable').innerHTML = `<tr><th>Sıra</th><th>Öğrenci</th><th>Servis</th><th>Veli</th><th>Konum</th><th></th></tr>` +
    list.map((s) => `<tr>
      <td>${s.stop_order}</td>
      <td>${escapeHtml(s.name)}${s.absent_on ? `<div class="small" style="color:var(--warn)">${s.absent_on} gelmeyecek</div>` : ''}</td>
      <td>${escapeHtml(busName(s.bus_id))}</td>
      <td>${escapeHtml(s.parent_name || '')}<div class="muted small">${escapeHtml(s.parent_phone || '')}</div></td>
      <td>${s.lat != null ? '✅' : '<span style="color:var(--danger)">Yok</span>'}</td>
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
  $('attTable').innerHTML = `<tr><th>Öğrenci</th><th>Servis</th><th>Sabah (bindi → indi)</th><th>Akşam (bindi → indi)</th></tr>` +
    (rows.map((s) => `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(busName(s.bus_id))}</td>
      <td>${cell(s.morning, s.parentAbsent)}</td><td>${cell(s.afternoon, s.parentAbsent)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="muted">Kayıt yok</td></tr>');
}
$('attDate').onchange = loadAttendance;
$('attBus').onchange = loadAttendance;

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
  $('who').textContent = me.user.isSuper ? `${me.user.username} (süper yönetici)` : me.user.companyName || me.user.username;
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
