// Demo verisi: 1 firma (kullanıcı: demo / demo123), 1 okul, 2 servis, 10 öğrenci. Veritabanı boşsa ekler.
import { db, newToken, hashPassword } from './db.js';

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

  const students = [
    [b1, 'Ayşe Demir', 41.0410, 29.0790], [b1, 'Can Öztürk', 41.0385, 29.0825],
    [b1, 'Elif Şahin', 41.0352, 29.0861], [b1, 'Deniz Arslan', 41.0318, 29.0884],
    [b1, 'Zeynep Çelik', 41.0290, 29.0915],
    [b2, 'Mert Aydın', 41.0120, 29.1105], [b2, 'Selin Koç', 41.0152, 29.1070],
    [b2, 'Emre Kurt', 41.0181, 29.1038], [b2, 'İrem Polat', 41.0209, 29.1010],
    [b2, 'Kaan Yıldız', 41.0230, 29.0985],
  ];
  const ins = db.prepare(`INSERT INTO students (company_id, name, bus_id, address, lat, lng, stop_order, parent_name, parent_phone, parent_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  students.forEach(([bus, name, lat, lng], i) => ins.run(company, name, bus, 'Demo adres', lat, lng, i % 5 + 1, `${name.split(' ')[1]} ailesi`, null, newToken()));
  console.log('Demo verisi eklendi. Firma girişi: demo / demo123');
}
