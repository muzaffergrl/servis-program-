// Demo verisi: 1 firma (kullanıcı: demo / demo123), 1 okul, 2 servis, 11 öğrenci,
// son 3 haftanın yoklaması, aidatlar, araç belgeleri ve bir duyuru. Veritabanı boşsa ekler.
import { db, newToken, hashPassword, today } from './db.js';

if (db.prepare('SELECT COUNT(*) AS n FROM companies').get().n > 0) {
  console.log('Veritabanında zaten firma var, demo verisi eklenmedi.');
} else {
  const company = Number(db.prepare('INSERT INTO companies (name, phone) VALUES (?, ?)').run('Demo Servis', '05550000000').lastInsertRowid);
  db.prepare('INSERT INTO users (company_id, username, password_hash, name) VALUES (?, ?, ?, ?)')
    .run(company, 'demo', hashPassword('demo123'), 'Demo Servis');

  const school = Number(db.prepare('INSERT INTO schools (company_id, name, lat, lng) VALUES (?, ?, ?, ?)')
    .run(company, 'Demo Koleji', 41.0255, 29.0960).lastInsertRowid);

  const addBus = (name, plate, driver, phone) => Number(db.prepare(
    'INSERT INTO buses (company_id, name, plate, driver_name, driver_phone, school_id, driver_token) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(company, name, plate, driver, phone, school, newToken()).lastInsertRowid);

  const b1 = addBus('Servis 1', '34 ABC 101', 'Ahmet Yılmaz', '05551112233');
  const b2 = addBus('Servis 2', '34 ABC 202', 'Mehmet Kaya', '05554445566');

  // [servis, ad, enlem, boylam, adres, veli, veli telefonu, aylık ücret]
  const students = [
    [b1, 'Ayşe Demir', 41.0410, 29.0790, 'Lale Sk. No 4', 'Fatma Demir', '05321000001', 2500],
    [b1, 'Can Öztürk', 41.0385, 29.0825, 'Menekşe Sk. No 12', 'Murat Öztürk', '05321000002', 2500],
    [b1, 'Elif Şahin', 41.0352, 29.0861, 'Çınar Cd. No 27', 'Zehra Şahin', '05321000003', 2500],
    [b1, 'Deniz Arslan', 41.0318, 29.0884, 'Gül Sk. No 8', 'Okan Arslan', '05321000004', 2500],
    [b1, 'Zeynep Çelik', 41.0290, 29.0915, 'Papatya Sk. No 3', 'Derya Çelik', '05321000005', 2500],
    [b2, 'Mert Aydın', 41.0120, 29.1105, 'Ihlamur Sk. No 6', 'Selma Aydın', '05321000006', 2800],
    [b2, 'Selin Koç', 41.0152, 29.1070, 'Akasya Sk. No 15', 'Hakan Koç', '05321000007', 2800],
    [b2, 'Emre Kurt', 41.0181, 29.1038, 'Söğüt Sk. No 2', 'Aylin Kurt', '05321000008', 2800],
    [b2, 'İrem Polat', 41.0209, 29.1010, 'Defne Sk. No 9', 'Kemal Polat', '05321000009', 2800],
    [b2, 'Kaan Yıldız', 41.0230, 29.0985, 'Nar Sk. No 11', 'Ebru Yıldız', '05321000010', 2800],
    // Elif'in kardeşi: aynı veli telefonu, veli tek linkten iki çocuğu da görür
    [b2, 'Ali Şahin', 41.0352, 29.0861, 'Çınar Cd. No 27', 'Zehra Şahin', '05321000003', 2000],
  ];
  const ins = db.prepare(`INSERT INTO students (company_id, name, bus_id, address, lat, lng, stop_order, parent_name, parent_phone, monthly_fee, parent_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ids = students.map(([bus, name, lat, lng, addr, parent, phone, fee], i) =>
    ({ id: Number(ins.run(company, name, bus, addr, lat, lng, i % 5 + 1, parent, phone, fee, newToken()).lastInsertRowid), bus, order: i % 5, fee }));

  // Son 3 haftanın yoklaması (hafta içi). "Servis genelde 07:31'de gelir" tahmini bundan öğrenilir.
  const att = db.prepare(`INSERT INTO attendance (company_id, bus_id, student_id, date, trip_type, event, at, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'driver')`);
  const istanbul = (date, h, m) => new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+03:00`).getTime();
  let rnd = 7;
  const jitter = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return (rnd % 5) - 2; }; // -2..+2 dk
  for (let d = 21; d >= 1; d--) {
    const day = new Date(Date.now() - d * 86400_000);
    const date = today(day);
    const wd = new Date(`${date}T12:00:00+03:00`).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (const s of ids) {
      if ((s.id * 7 + d) % 17 === 0) { att.run(company, s.bus, s.id, date, 'morning', 'absent', istanbul(date, 7, 25 + s.order * 3)); continue; }
      const base = s.bus === b1 ? 25 : 20;
      att.run(company, s.bus, s.id, date, 'morning', 'boarded', istanbul(date, 7, base + s.order * 3 + jitter()));
      att.run(company, s.bus, s.id, date, 'morning', 'dropped', istanbul(date, 7, base + 18 + jitter()));
      att.run(company, s.bus, s.id, date, 'afternoon', 'boarded', istanbul(date, 15, 40));
      att.run(company, s.bus, s.id, date, 'afternoon', 'dropped', istanbul(date, 15, 55 + (4 - s.order) * 3 + jitter()));
    }
  }

  // Bu ayın aidatları: çoğu ödenmiş, birkaçı bekliyor
  const month = today().slice(0, 7);
  const pay = db.prepare('INSERT INTO payments (company_id, student_id, month, amount, paid_at) VALUES (?, ?, ?, ?, ?)');
  ids.forEach((s, i) => { if (i % 4 !== 1) pay.run(company, s.id, month, s.fee, Date.now() - (10 - i) * 86400_000); });

  // Araç belgeleri: biri yakında bitiyor, biri bitmiş (uyarı örneği)
  const doc = db.prepare('INSERT INTO documents (company_id, bus_id, kind, expires_on, note) VALUES (?, ?, ?, ?, ?)');
  const inDays = (n) => today(new Date(Date.now() + n * 86400_000));
  doc.run(company, b1, 'Araç muayenesi', inDays(12), null);
  doc.run(company, b1, 'Zorunlu trafik sigortası', inDays(140), null);
  doc.run(company, b1, 'Koltuk ferdi kaza sigortası', inDays(200), null);
  doc.run(company, b2, 'Araç muayenesi', inDays(95), null);
  doc.run(company, b2, 'Okul servis aracı izin belgesi', inDays(-3), 'Belediyeye başvuru yapıldı');
  doc.run(company, b2, 'Şoför psikoteknik belgesi', inDays(25), 'Mehmet Kaya');

  db.prepare('INSERT INTO announcements (company_id, bus_id, text, created_at) VALUES (?, NULL, ?, ?)')
    .run(company, 'Cuma günü okul 12:30\'da dağılacak, akşam servisi 12:45\'te kalkacak.', Date.now() - 3600_000);

  console.log('Demo verisi eklendi. Firma girişi: demo / demo123');
}
