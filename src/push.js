// Web push: telefon kilitliyken de veliye bildirim gider.
// Android'de tarayıcıdan, iPhone'da (iOS 16.4+) sayfa "Ana Ekrana Ekle" yapılınca çalışır.
import webpush from 'web-push';
import { db, getSetting, setSetting } from './db.js';

let keys = null;

function vapid() {
  if (keys) return keys;
  keys = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
    ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
    : JSON.parse(getSetting('vapid') || 'null');
  if (!keys) {
    // İlk çalışmada bir kez üretilir ve saklanır (değişirse tüm abonelikler geçersiz olur)
    keys = webpush.generateVAPIDKeys();
    setSetting('vapid', JSON.stringify(keys));
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:destek@example.com', keys.publicKey, keys.privateKey);
  return keys;
}

export const publicKey = () => vapid().publicKey;

export function saveSubscription(studentId, sub) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Geçersiz abonelik');
  if (!/^https:\/\//.test(sub.endpoint)) throw new Error('Geçersiz abonelik');
  db.prepare(`INSERT INTO push_subs (student_id, endpoint, keys, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET student_id = excluded.student_id, keys = excluded.keys`)
    .run(studentId, sub.endpoint, JSON.stringify(sub.keys), Date.now());
}

export function removeSubscription(endpoint) {
  db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
}

export const hasSubscription = (studentId) =>
  !!db.prepare('SELECT 1 FROM push_subs WHERE student_id = ? LIMIT 1').get(studentId);

/** Bir öğrencinin tüm velilerine (birden fazla telefon olabilir) bildirim gönder */
export async function pushToStudent(studentId, { title, body, url, tag }) {
  if (process.env.PUSH_DISABLED) return;
  const subs = db.prepare('SELECT * FROM push_subs WHERE student_id = ?').all(studentId);
  if (!subs.length) return;
  vapid();
  const payload = JSON.stringify({ title, body, url, tag });
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, payload, { TTL: 600, urgency: 'high' });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) removeSubscription(s.endpoint); // abonelik iptal edilmiş
      else console.warn('[push]', e.statusCode || '', e.message);
    }
  }));
}
