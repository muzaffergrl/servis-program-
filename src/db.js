import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const file = process.env.DB_FILE || path.join(process.cwd(), 'data', 'servis.db');
if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec('PRAGMA foreign_keys = ON;');
if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
-- Servis firmaları (müşterilerimiz)
CREATE TABLE IF NOT EXISTS companies (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Panel kullanıcıları. company_id boşsa süper yönetici (tüm firmalar)
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schools (
  id         INTEGER PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS buses (
  id           INTEGER PRIMARY KEY,
  company_id   INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  plate        TEXT,
  driver_name  TEXT,
  driver_phone TEXT,
  school_id    INTEGER REFERENCES schools(id) ON DELETE SET NULL,
  driver_token TEXT NOT NULL UNIQUE,
  -- Mevcut takip programındaki araç kimliği (API bağlanınca eşleştirme için)
  external_id  TEXT
);

CREATE TABLE IF NOT EXISTS students (
  id           INTEGER PRIMARY KEY,
  company_id   INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  bus_id       INTEGER REFERENCES buses(id) ON DELETE SET NULL,
  address      TEXT,
  lat          REAL,
  lng          REAL,
  stop_order   INTEGER NOT NULL DEFAULT 0,
  parent_name  TEXT,
  parent_phone TEXT,
  parent_token TEXT NOT NULL UNIQUE,
  absent_on    TEXT,                       -- 'YYYY-MM-DD': o gün servise binmeyecek
  notify_min   INTEGER NOT NULL DEFAULT 5  -- veli kaç dk kala haber almak istiyor
);

-- Yoklama kayıtları: bindi / binmedi / indi
CREATE TABLE IF NOT EXISTS attendance (
  id         INTEGER PRIMARY KEY,
  company_id INTEGER,
  bus_id     INTEGER,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  trip_type  TEXT NOT NULL,   -- morning | afternoon
  event      TEXT NOT NULL,   -- boarded | absent | dropped
  at         INTEGER NOT NULL,
  source     TEXT NOT NULL DEFAULT 'driver'
);
CREATE INDEX IF NOT EXISTS attendance_student ON attendance(student_id, date);

-- Velilerin bildirim abonelikleri (web push)
CREATE TABLE IF NOT EXISTS push_subs (
  id         INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  keys       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// İlk sürümden kalan veritabanları için eksik sütunları ekle
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
for (const t of ['schools', 'buses', 'students']) addColumn(t, 'company_id', 'INTEGER REFERENCES companies(id) ON DELETE CASCADE');
addColumn('students', 'notify_min', 'INTEGER NOT NULL DEFAULT 5');

export const newToken = (bytes = 12) => randomBytes(bytes).toString('base64url');

const TZ = process.env.TZ_NAME || 'Europe/Istanbul';
/** Türkiye saatine göre tarih (YYYY-MM-DD) */
export const today = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

export function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// --- Şifreler ------------------------------------------------------------
export function hashPassword(pw) {
  const salt = randomBytes(16).toString('base64url');
  return `scrypt$${salt}$${scryptSync(pw, salt, 32).toString('base64url')}`;
}
export function checkPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const a = scryptSync(String(pw), salt, 32);
  const b = Buffer.from(hash, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Ortam değişkenindeki süper yöneticiyi oluştur / şifresini güncelle */
export function ensureSuperAdmin(username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u) {
    db.prepare('INSERT INTO users (company_id, username, password_hash, name) VALUES (NULL, ?, ?, ?)')
      .run(username, hashPassword(password), 'Süper yönetici');
  } else if (u.company_id == null && !checkPassword(password, u.password_hash)) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
  }
}
