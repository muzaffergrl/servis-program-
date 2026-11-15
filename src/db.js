import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const file = process.env.DB_FILE || path.join(process.cwd(), 'data', 'servis.db');
if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec('PRAGMA foreign_keys = ON;');
if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS schools (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  lat  REAL NOT NULL,
  lng  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS buses (
  id           INTEGER PRIMARY KEY,
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
  name         TEXT NOT NULL,
  bus_id       INTEGER REFERENCES buses(id) ON DELETE SET NULL,
  address      TEXT,
  lat          REAL,
  lng          REAL,
  stop_order   INTEGER NOT NULL DEFAULT 0,
  parent_name  TEXT,
  parent_phone TEXT,
  parent_token TEXT NOT NULL UNIQUE,
  absent_on    TEXT -- 'YYYY-MM-DD': o gün servise binmeyecek
);
`);

export const newToken = () => randomBytes(12).toString('base64url');

const TZ = process.env.TZ_NAME || 'Europe/Istanbul';
/** Türkiye saatine göre bugünün tarihi (YYYY-MM-DD) */
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
