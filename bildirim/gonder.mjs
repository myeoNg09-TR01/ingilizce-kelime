// GitHub Actions her gün bu dosyayı çalıştırır ve telefona hatırlatma bildirimi yollar.
import { readFileSync } from 'node:fs';
import webpush from 'web-push';

const config = readFileSync(new URL('../config.js', import.meta.url), 'utf8');
const publicKey = (config.match(/vapidPublic:\s*'([^']*)'/) || [])[1];
const privateKey = process.env.VAPID_PRIVATE_KEY;
const rawSub = process.env.PUSH_SUBSCRIPTION;

if (!publicKey || !privateKey) { console.log('VAPID anahtarları eksik, bildirim gönderilmedi.'); process.exit(0); }
if (!rawSub) { console.log('PUSH_SUBSCRIPTION henüz kaydedilmemiş, bildirim gönderilmedi.'); process.exit(0); }

let subscription;
try { subscription = JSON.parse(rawSub.trim()); } catch {
  console.error('PUSH_SUBSCRIPTION geçerli bir kod değil. Uygulamadaki kodu eksiksiz kopyalayıp tekrar kaydet.');
  process.exit(1);
}

webpush.setVapidDetails(process.env.VAPID_SUBJECT, publicKey, privateKey);
try {
  const res = await webpush.sendNotification(subscription, JSON.stringify({
    title: 'Günün Kelimeleri',
    body: 'Bugünün 2 kelimesi hazır. Dokun ve dinle.',
  }));
  console.log('Bildirim gönderildi:', res.statusCode);
} catch (e) {
  console.error('Bildirim gönderilemedi:', e.statusCode || '', e.body || e.message);
  if (e.statusCode === 404 || e.statusCode === 410) {
    console.error('Telefondaki bildirim kaydı geçersiz olmuş. Uygulamada bildirimi yeniden açıp yeni kodu kaydet.');
  }
  process.exit(1);
}
