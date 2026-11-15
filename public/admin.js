let S = { schools: [], buses: [], students: [] };
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

// --- Sekmeler ------------------------------------------------------------
document.querySelectorAll('nav button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('active', s.id === `tab-${b.dataset.tab}`));
  setTimeout(() => [liveMap, pickMap, schoolMap].forEach((m) => m?.invalidateSize()), 50);
});

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
  const f = $('studentFilter');
  const fv = f.value;
  f.innerHTML = '<option value="">Tümü</option>' + S.buses.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  f.value = fv;
}

function renderLive() {
  $('liveList').innerHTML = S.buses.map((b) => {
    const t = b.live.trip;
    const active = t && !t.finishedAt;
    const status = active
      ? `<span class="dot ok"></span> ${t.type === 'morning' ? 'Sabah turu' : 'Akşam turu'}${b.simulating ? ' (simülasyon)' : ''}`
      : t?.finishedAt ? `<span class="dot"></span> Tur bitti ${fmtTime(t.finishedAt)}` : '<span class="dot"></span> Beklemede';
    const stops = active ? `<ol>${t.stops.map((s) => `<li class="${s.done ? 'done' : ''}">${escapeHtml(s.name)} — ${s.done ? fmtTime(s.doneAt) : fmtMin(s.etaSec) + ' dk'}</li>`).join('')}</ol>` : '';
    const stale = active && b.live.pos?.stale ? '<div class="small" style="color:var(--warn)">⚠️ Konum 2 dakikadır gelmiyor</div>' : '';
    return `<div class="card bus-card">
      <b>${escapeHtml(b.name)}</b> <span class="muted small">${escapeHtml(b.plate || '')}</span>
      <div class="small">${status}</div>${stale}${stops}
      <div class="btns" style="margin-top:8px">
        ${active
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
    if (!m) { m = L.marker([p.lat, p.lng], { icon: busIcon() }).addTo(liveMap); busMarkers.set(b.id, m); }
    m.setLatLng([p.lat, p.lng]).setOpacity(p.stale ? 0.5 : 1).bindTooltip(b.name);
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

// --- Formlar -------------------------------------------------------------
function fillForm(form, obj) {
  for (const el of form.elements) if (el.name) el.value = obj[el.name] ?? '';
}
const formData = (form) => Object.fromEntries(new FormData(form));

function setupForm(formId, url, titleEl, newTitle, onReset) {
  const form = $(formId);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = formData(form);
    try {
      if (data.id) await api('PUT', `${url}/${data.id}`, data);
      else await api('POST', url, data);
      toast('Kaydedildi');
      form.querySelector('[data-reset]').click();
      await load();
    } catch (err) { toast(err.message); }
  };
  form.querySelector('[data-reset]').onclick = () => { form.reset(); form.elements.id.value = ''; $(titleEl).textContent = newTitle; onReset?.(); };
  return form;
}
const busForm = setupForm('busForm', '/api/admin/buses', 'busFormTitle', 'Yeni servis');
const studentForm = setupForm('studentForm', '/api/admin/students', 'studentFormTitle', 'Yeni öğrenci', () => { pickMarker?.remove(); pickMarker = null; });
const schoolForm = setupForm('schoolForm', '/api/admin/schools', 'schoolFormTitle', 'Yeni okul', () => { schoolPickMarker?.remove(); schoolPickMarker = null; });

function setPick(map, form, markerRef, lat, lng, emoji) {
  form.elements.lat.value = lat.toFixed(6);
  form.elements.lng.value = lng.toFixed(6);
  let m = markerRef();
  if (!m) m = L.marker([lat, lng], { icon: pinIcon(emoji) }).addTo(map);
  else m.setLatLng([lat, lng]);
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
        await api('DELETE', `/api/admin/buses/${id}/trip`);
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
    }
    await load();
  } catch (err) { toast(err.message); }
});

$('studentFilter').onchange = renderStudents;

// --- Başlangıç -----------------------------------------------------------
async function load() {
  S = await api('GET', '/api/admin/state');
  render();
}

(async () => {
  await load();
  const center = S.schools[0] ? [S.schools[0].lat, S.schools[0].lng] : [41.0255, 29.096];
  [liveMap, pickMap, schoolMap] = await Promise.all([makeMap('liveMap', center, 13), makeMap('pickMap', center, 13), makeMap('schoolMap', center, 13)]);
  for (const s of S.schools) L.marker([s.lat, s.lng], { icon: pinIcon('🏫') }).addTo(liveMap).bindTooltip(s.name);
  pickMap.on('click', (e) => { pickMarker = setPick(pickMap, studentForm, () => pickMarker, e.latlng.lat, e.latlng.lng, '🏠'); });
  schoolMap.on('click', (e) => { schoolPickMarker = setPick(schoolMap, schoolForm, () => schoolPickMarker, e.latlng.lat, e.latlng.lng, '🏫'); });
  renderLive();
  liveStream('/api/admin/stream', { state: (st) => { S = st; renderLive(); } });
})();
