'use strict';
// Başka bir sitenin içine gömülerek açılırsa çalışma (tıklama tuzağına karşı).
if (window.top !== window.self) { document.documentElement.hidden = true; throw new Error('Gömülü açılış engellendi'); }
// ---- Ayarlar -------------------------------------------------------------
const API = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const TEXT_MODEL = 'gemini-3.5-flash-lite';
const TTS_MODEL = 'gemini-3.8-flash-lite-tts';
const VOICE = 'Erinome';
const WORDS_PER_DAY = 2;
const MAX_CLIPS = 400; // telefonda saklanan en fazla ses kaydı

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ---- Saklama -------------------------------------------------------------
const store = {
  get key() { return localStorage.getItem('ek_key') || ''; },
  set key(v) { localStorage.setItem('ek_key', v); },
  get days() { try { return JSON.parse(localStorage.getItem('ek_days')) || []; } catch { return []; } },
  set days(v) { localStorage.setItem('ek_days', JSON.stringify(v)); },
  get topics() {
    try { const t = JSON.parse(localStorage.getItem('ek_topics')); return Array.isArray(t) ? t : ['Seyahat']; } catch { return ['Seyahat']; }
  },
  set topics(v) { localStorage.setItem('ek_topics', JSON.stringify(v)); },
  get ownTopic() { return localStorage.getItem('ek_own') || ''; },
  set ownTopic(v) { localStorage.setItem('ek_own', v); },
  // Tekrar soruları: kelime başına doğru/yanlış sayısı ve son sorulduğu gün
  get stats() { try { return JSON.parse(localStorage.getItem('ek_stats')) || {}; } catch { return {}; } },
  set stats(v) { localStorage.setItem('ek_stats', JSON.stringify(v)); },
  get quiz() { try { return JSON.parse(localStorage.getItem('ek_quiz')) || {}; } catch { return {}; } },
  set quiz(v) { localStorage.setItem('ek_quiz', JSON.stringify(v)); },
  // Cevap günlüğü: [{d: tarih, w: kelime, ok: doğru mu, k: 'ilk' (anlam tahmini) | 'tekrar'}]
  get log() { try { return JSON.parse(localStorage.getItem('ek_log')) || []; } catch { return []; } },
  set log(v) { localStorage.setItem('ek_log', JSON.stringify(v.slice(-600))); },
  get slow() { return localStorage.getItem('ek_slow') === '1'; },
  set slow(v) { localStorage.setItem('ek_slow', v ? '1' : '0'); },
};

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function niceDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' });
}

// ---- Gemini --------------------------------------------------------------
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function callGemini(body, timeoutMs = 30000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': store.key },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = Array.isArray(data) ? data[0] : data;
      throw new ApiError(res.status, (err && err.error && err.error.message) || `HTTP ${res.status}`);
    }
    return data;
  } finally { clearTimeout(timer); }
}

// Yanıtın içinde verilen türdeki parçaları bulur (yanıt biçimi değişse de çalışsın diye derin arama).
function findParts(node, type, out = []) {
  if (Array.isArray(node)) node.forEach((n) => findParts(n, type, out));
  else if (node && typeof node === 'object') {
    if (node.type === type) out.push(node);
    Object.values(node).forEach((v) => findParts(v, type, out));
  }
  return out;
}
function modelOutput(data) {
  const steps = data && Array.isArray(data.steps) ? data.steps.filter((s) => s.type === 'model_output') : [];
  return steps.length ? steps : data;
}
function extractText(data) {
  if (data && typeof data.output_text === 'string') return data.output_text;
  return findParts(modelOutput(data), 'text').map((p) => p.text).filter((t) => typeof t === 'string').join('');
}

const WORD_SCHEMA = {
  type: 'object',
  properties: {
    words: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          word: { type: 'string' },
          okunus: { type: 'string' },
          tur: { type: 'string' },
          anlam: { type: 'string' },
          yanlis: { type: 'array', items: { type: 'string' } },
          cumleler: {
            type: 'array',
            items: { type: 'object', properties: { en: { type: 'string' }, tr: { type: 'string' } }, required: ['en', 'tr'] },
          },
        },
        required: ['word', 'okunus', 'tur', 'anlam', 'yanlis', 'cumleler'],
      },
    },
  },
  required: ['words'],
};

const TOPICS = {
  'Seyahat': 'seyahat (havaalanı, uçak, otel, ulaşım, yol sorma, acil durum)',
  'Günlük konuşma': 'günlük konuşma (tanışma, sohbet, duygular, planlar)',
  'Yeme-içme': 'yeme-içme (restoran, kafe, sipariş, market)',
  'Alışveriş': 'alışveriş (mağaza, fiyat, beden, ödeme, iade)',
  'İş hayatı': 'iş hayatı (toplantı, e-posta, telefon görüşmesi)',
  'Sağlık': 'sağlık (eczane, doktor, şikâyet anlatma)',
  'Teknoloji': 'teknoloji (telefon, internet, uygulamalar)',
  'Dizi-film': 'dizi ve filmlerde sık geçen günlük ifadeler',
};

function buildPrompt(known) {
  const areas = store.topics.map((t) => TOPICS[t]).filter(Boolean);
  if (store.ownTopic) areas.push(store.ownTopic);
  if (!areas.length) areas.push(TOPICS['Seyahat']); // hiç konu seçilmediyse
  return `Sen bir İngilizce öğretmenisin. Öğrenci Türk, seviyesi başlangıç ile orta arası (A2-B1).
Bugün için ${WORDS_PER_DAY} yeni İngilizce kelime veya kısa kalıp seç. Kelimeleri şu konu alanlarından seç (birden fazlaysa günden güne değiştir): ${areas.join('; ')}.
Her kelime için:
- word: İngilizce kelime (küçük harfle)
- okunus: Türkçe harflerle yaklaşık okunuşu (örnek: "luggage" için "lagıc")
- tur: kelimenin türü, Türkçe (isim, fiil, sıfat, kalıp…)
- anlam: kısa Türkçe anlamı
- yanlis: çoktan seçmeli soru için 3 çeldirici: kelimenin anlamı OLMAYAN ama aynı türden ve aynı konudan, inandırıcı, kısa Türkçe anlamlar. Doğru anlamla eş anlamlı olmasınlar.
- cumleler: o konuda gerçek hayatta kullanılacak 3 kısa ve basit İngilizce cümle (en) ve Türkçe çevirileri (tr). Her cümlede kelime geçmeli. Cümleleri normal yazım kurallarıyla yaz (ilk harf büyük).
Şu kelimeleri daha önce verdin, bunları tekrar seçme: ${known.length ? known.join(', ') : '(henüz yok)'}.
Yalnızca JSON döndür.`;
}

function parseWords(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const obj = JSON.parse(clean);
  const list = Array.isArray(obj) ? obj : obj.words;
  if (!Array.isArray(list)) throw new Error('Beklenmeyen yanıt');
  const words = list.filter((w) => w && w.word && w.anlam && Array.isArray(w.cumleler) && w.cumleler.length)
    .slice(0, WORDS_PER_DAY)
    .map((w) => ({
      word: String(w.word).trim(), okunus: String(w.okunus || '').trim(), tur: String(w.tur || '').trim(),
      anlam: String(w.anlam).trim(),
      yanlis: (Array.isArray(w.yanlis) ? w.yanlis : []).map((y) => String(y).trim())
        .filter((y, i, a) => y && y.toLowerCase() !== String(w.anlam).trim().toLowerCase() && a.indexOf(y) === i).slice(0, 3),
      cumleler: w.cumleler.filter((c) => c && c.en).map((c) => ({ en: String(c.en).trim(), tr: String(c.tr || '').trim() })),
    }));
  if (words.length < WORDS_PER_DAY) throw new Error('Eksik kelime geldi');
  return words;
}

async function fetchWords() {
  const known = store.days.flatMap((d) => d.words.map((w) => w.word));
  const data = await callGemini({
    model: TEXT_MODEL,
    input: buildPrompt(known),
    response_format: { type: 'text', mime_type: 'application/json', schema: WORD_SCHEMA },
  });
  return parseWords(extractText(data));
}

async function fetchSpeech(text) {
  const data = await callGemini({
    model: TTS_MODEL,
    input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: VOICE }] },
  }, 10000);
  const parts = findParts(modelOutput(data), 'audio').filter((p) => typeof p.data === 'string');
  if (!parts.length) throw new Error('Ses gelmedi');
  const part = parts[parts.length - 1];
  const bin = atob(part.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: part.mime_type || 'audio/wav' });
}

function errorText(e) {
  if (!navigator.onLine) return 'İnternet bağlantısı yok.';
  if (e instanceof ApiError) {
    if (e.status === 400 || e.status === 401 || e.status === 403) return 'API anahtarı kabul edilmedi. Ayarlar\'dan kontrol et.';
    if (e.status === 429) return 'Gemini kotası doldu. Biraz sonra tekrar dene.';
    return `Gemini hata verdi (${e.status}).`;
  }
  if (e && e.name === 'AbortError') return 'Gemini yanıt vermedi, bağlantı yavaş olabilir.';
  return 'Kelimeler alınamadı.';
}

// ---- Ses kayıtları (IndexedDB) -------------------------------------------
let dbPromise;
function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('ek_audio', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('clips');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function clipOp(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('clips', mode);
    const req = fn(tx.objectStore('clips'));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const clipKey = (text) => `${VOICE}|${text.toLowerCase()}`;
async function getClip(text) {
  try { const r = await clipOp('readonly', (s) => s.get(clipKey(text))); return r ? r.blob : null; } catch { return null; }
}
async function putClip(text, blob) {
  try {
    await clipOp('readwrite', (s) => s.put({ blob, t: Date.now() }, clipKey(text)));
    const keys = await clipOp('readonly', (s) => s.getAllKeys());
    if (keys.length > MAX_CLIPS) { // en eskileri sil
      const all = await clipOp('readonly', (s) => s.getAll());
      const order = keys.map((k, i) => [k, all[i].t]).sort((a, b) => a[1] - b[1]).slice(0, keys.length - MAX_CLIPS);
      await clipOp('readwrite', (s) => { order.forEach(([k]) => s.delete(k)); });
    }
  } catch { /* saklanamadıysa sorun değil */ }
}

// ---- Seslendirme ---------------------------------------------------------
const player = new Audio();
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
let unlocked = false;
let ttsBlockedUntil = 0; // kota dolarsa bir süre doğrudan telefon sesine geç
let lastUrl = null;

// iPhone, sesi ancak dokunma anında başlatılan oynatıcıdan çalar; ilk dokunuşta kilidi aç.
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  player.src = SILENCE;
  player.play().catch(() => {});
  if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
}

function phoneVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
  const score = (v) => (/en[-_]US/i.test(v.lang) ? 2 : 0) + (/enhanced|premium|geli/i.test(v.name) ? 3 : 0) + (v.name === 'Samantha' ? 1 : 0);
  return voices.sort((a, b) => score(b) - score(a))[0] || null;
}
function speakWithPhone(text, slow) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    const v = phoneVoice();
    if (v) u.voice = v;
    u.rate = slow ? 0.6 : 0.9;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}
function playBlob(blob, slow) {
  return new Promise((resolve, reject) => {
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    player.onended = () => resolve();
    player.onerror = () => reject(new Error('Ses çalınamadı'));
    player.src = lastUrl;
    player.playbackRate = slow ? 0.75 : 1;
    player.play().catch(reject);
  });
}

async function speak(text, btn) {
  unlockAudio();
  player.pause();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  const slow = store.slow;
  btn && btn.classList.add('busy');
  try {
    let blob = await getClip(text);
    if (!blob && store.key && navigator.onLine && Date.now() > ttsBlockedUntil) {
      try {
        blob = await fetchSpeech(text);
        putClip(text, blob);
      } catch (e) {
        // Sınıra takıldıysa kısa süre telefon sesine geç; arka plandaki indirme devam eder.
        if (e instanceof ApiError && e.status === 429) ttsBlockedUntil = Date.now() + 20 * 1000;
        blob = null;
      }
    }
    if (blob) {
      try { await playBlob(blob, slow); return; } catch { /* telefon sesine düş */ }
    }
    await speakWithPhone(text, slow);
  } finally { btn && btn.classList.remove('busy'); }
}

// ---- Ekran ---------------------------------------------------------------
const SPEAKER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18.3 6.3a8 8 0 0 1 0 11.4"/></svg>';
function playButton(text, big) {
  const b = el('button', big ? 'play big' : 'play');
  b.innerHTML = SPEAKER;
  b.setAttribute('aria-label', `Dinle: ${text}`);
  b.addEventListener('click', (e) => { e.preventDefault(); speak(text, b); });
  return b;
}
const cap = (s) => (s ? s.charAt(0).toLocaleUpperCase('tr-TR') + s.slice(1) : s);
const capEn = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
function logAnswer(word, ok, kind) {
  store.log = [...store.log, { d: todayStr(), w: word, ok, k: kind }];
}
// Bugünün kelimesinde ilk tahmini kalıcı olarak işaretler.
function saveGuess(word, ok) {
  const days = store.days;
  const entry = days.find((d) => d.date === todayStr());
  const w = entry && entry.words.find((x) => x.word === word);
  if (w) { w.guess = ok; store.days = days; }
  logAnswer(word, ok, 'ilk');
}

// guessable: anlam gizlenir, önce 4 seçenekten tahmin edilir (yalnızca bugünün yeni kelimeleri).
function wordCard(w, no, guessable) {
  const asking = guessable && w.guess === undefined && Array.isArray(w.yanlis) && w.yanlis.length >= 3;
  if (asking) return guessCard(w, no);
  return revealedCard(w, no);
}
function guessCard(w, no) {
  const card = revealedCard(w, no);
  card.classList.add('hide-tr');
  const stamp = card.querySelector('.meaning');
  const box = el('div', 'guess');
  box.append(el('div', 'qhint', 'Anlamı hangisi? Cümleler ipucu verir.'));
  const options = shuffle([w.anlam, ...w.yanlis.slice(0, 3)]);
  const buttons = options.map((text) => {
    const b = el('button', 'opt', text);
    b.addEventListener('click', () => {
      const ok = text === w.anlam;
      buttons.forEach((x, i) => { x.disabled = true; if (options[i] === w.anlam) x.classList.add('ok'); });
      if (!ok) b.classList.add('no');
      w.guess = ok;
      saveGuess(w.word, ok);
      speak(w.word);
      setTimeout(() => card.replaceWith(revealedCard(w, no)), ok ? 1100 : 2000);
    });
    return b;
  });
  box.append(...buttons);
  stamp.replaceWith(box);
  return card;
}
function revealedCard(w, no) {
  const card = el('article', 'card');
  const strip = el('div', 'strip');
  const label = el('span', null, 'Kelime ');
  label.append(el('b', null, String(no || 1).padStart(2, '0')));
  strip.append(label, el('span', null, w.tur));
  const row = el('div', 'wordrow');
  const left = el('div');
  left.append(el('div', 'word', w.word), el('div', 'meta', w.okunus ? `okunuşu: ${w.okunus}` : ''));
  row.append(left, playButton(w.word, true));
  card.append(strip, row, el('div', 'meaning', w.anlam), el('div', 'perf'));
  w.cumleler.forEach((c, i) => {
    const s = el('div', 'sent');
    const t = el('div', 'txt');
    t.append(el('div', 'en', capEn(c.en)), el('div', 'tr', cap(c.tr)));
    s.append(el('span', 'no', String(i + 1)), t, playButton(c.en));
    card.append(s);
  });
  return card;
}

// Bugünün seslerini arka planda indir: dokununca beklemeden çalsın, internetsiz de çalışsın.
let prefetching = false;
async function prefetchAudio(words) {
  if (prefetching || !store.key || !navigator.onLine) return;
  prefetching = true;
  try {
    // Ücretsiz kota dakikada birkaç sesle sınırlı: sınıra takılınca bekleyip kaldığı yerden devam eder.
    let waits = 0;
    const texts = words.flatMap((w) => [w.word, ...w.cumleler.map((c) => c.en)]);
    for (let i = 0; i < texts.length; i++) {
      if (await getClip(texts[i])) continue;
      try { await putClip(texts[i], await fetchSpeech(texts[i])); } catch (e) {
        if (!(e instanceof ApiError && e.status === 429) || ++waits > 12 || !navigator.onLine) break;
        await new Promise((r) => setTimeout(r, 25000));
        i--;
      }
    }
  } finally { prefetching = false; }
}

// ---- Seri ----------------------------------------------------------------
const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return todayStr(d); };
function streakInfo(dates, today) {
  const set = new Set(dates);
  let cur = 0;
  let d = set.has(today) ? today : addDays(today, -1); // bugün henüz açılmadıysa seri bozulmuş sayılmaz
  while (set.has(d)) { cur++; d = addDays(d, -1); }
  let best = 0, run = 0, prev = null;
  [...set].sort().forEach((x) => { run = prev && addDays(prev, 1) === x ? run + 1 : 1; best = Math.max(best, run); prev = x; });
  return { cur, best, set };
}
function renderStreak() {
  const today = todayStr();
  const { cur, best, set } = streakInfo(store.days.map((d) => d.date), today);
  const box = $('streak');
  box.replaceChildren();
  for (let i = 6; i >= 0; i--) {
    const day = addDays(today, -i);
    const dot = el('span', 'dot' + (set.has(day) ? ' on' : '') + (i === 0 ? ' today' : ''),
      toDate(day).toLocaleDateString('tr-TR', { weekday: 'narrow' }));
    box.append(dot);
  }
  const txt = el('div', 'txt');
  txt.append(el('b', null, `${cur} gün seri`), document.createElement('br'), `en uzun ${best}`);
  box.append(txt);
}

// ---- Tekrar soruları -----------------------------------------------------
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function buildQuiz(days, stats, today, count = 3) {
  const uniq = (list) => [...new Map(list.map((w) => [w.word, w])).values()];
  const old = uniq(days.filter((d) => d.date !== today).flatMap((d) => d.words));
  const all = uniq(days.flatMap((d) => d.words));
  if (!old.length || all.length < 3) return null;
  // Yanlış bilinenler ve uzun süredir sorulmayanlar öne gelir.
  const score = (w) => {
    const s = stats[w.word] || {};
    const since = s.last ? Math.min(30, Math.round((toDate(today) - toDate(s.last)) / 864e5)) : 30;
    return ((s.no || 0) - (s.ok || 0)) * 4 + since + Math.random() * 3;
  };
  return old.map((w) => [w, score(w)]).sort((a, b) => b[1] - a[1]).slice(0, count).map(([w], i) => {
    const others = shuffle(all.filter((o) => o.word !== w.word && o.anlam !== w.anlam)).slice(0, 3);
    return { word: w, type: i % 2 ? 'listen' : 'tr2en', options: shuffle([w, ...others]) };
  });
}
function recordAnswer(word, right) {
  const stats = store.stats;
  const s = stats[word] || { ok: 0, no: 0 };
  if (right) s.ok++; else s.no++;
  s.last = todayStr();
  stats[word] = s;
  store.stats = stats;
  logAnswer(word, right, 'tekrar');
}

// ---- Haftalık değerlendirme ----------------------------------------------
function weekSummary(days, log, today) {
  const since = addDays(today, -6);
  const recent = log.filter((e) => e.d >= since && e.d <= today);
  const rate = (kind) => {
    const list = recent.filter((e) => e.k === kind);
    return { ok: list.filter((e) => e.ok).length, total: list.length };
  };
  const wrong = new Map();
  recent.filter((e) => !e.ok).forEach((e) => wrong.set(e.w, (wrong.get(e.w) || 0) + 1));
  const byWord = new Map(days.flatMap((d) => d.words).map((w) => [w.word, w]));
  const missed = [...wrong].filter(([w]) => byWord.has(w)).sort((a, b) => b[1] - a[1])
    .map(([w, n]) => ({ word: byWord.get(w), n }));
  return {
    newWords: days.filter((d) => d.date >= since && d.date <= today).reduce((n, d) => n + d.words.length, 0),
    first: rate('ilk'), review: rate('tekrar'), missed,
  };
}
function weekCard() {
  const s = weekSummary(store.days, store.log, todayStr());
  const card = el('article', 'card week');
  const strip = el('div', 'strip');
  strip.append(el('span', null, 'Değerlendirme'), el('span', null, 'Son 7 gün'));
  const nums = el('div', 'nums');
  const num = (big, label) => { const d = el('div'); d.append(el('b', null, big), el('span', null, label)); return d; };
  const frac = (r) => (r.total ? `${r.ok}/${r.total}` : '–');
  nums.append(num(String(s.newWords), 'yeni kelime'), num(frac(s.first), 'ilk tahmin'), num(frac(s.review), 'tekrar'));
  card.append(strip, nums, el('div', 'perf'));
  if (!s.first.total && !s.review.total) {
    card.append(el('div', 'help', 'Kelimelerin anlamını tahmin ettikçe ve tekrar sorularını çözdükçe burada bilemediklerin listelenir.'));
  } else if (!s.missed.length) {
    card.append(el('div', 'help', 'Bu hafta bilemediğin kelime yok.'));
  } else {
    card.append(el('div', 'qhint', 'Bilemediklerin'));
    s.missed.forEach(({ word, n }) => {
      const row = el('div', 'sent');
      const t = el('div', 'txt');
      t.append(el('div', 'en', word.word), el('div', 'tr', word.anlam));
      row.append(el('span', 'no', `×${n}`), t, playButton(word.word));
      card.append(row);
    });
  }
  return card;
}
function quizDoneLine(q) {
  const line = el('div', 'quizdone');
  line.append(el('span', null, 'Tekrar tamam'), el('b', null, `${q.score}/${q.total} doğru`));
  return line;
}
function quizCard(questions) {
  const card = el('article', 'card quiz');
  let idx = 0, right = 0;
  const showQuestion = () => {
    const q = questions[idx];
    card.replaceChildren();
    const strip = el('div', 'strip');
    const label = el('span', null, 'Tekrar ');
    label.append(el('b', null, `${idx + 1}/${questions.length}`));
    strip.append(label, el('span', null, 'Eski kelimeler'));
    card.append(strip);
    if (q.type === 'listen') {
      const row = el('div', 'qlisten');
      row.append(playButton(q.word.word, true), el('div', 'qhint', 'Dinle, anlamını seç.'));
      card.append(row);
      speak(q.word.word);
    } else {
      card.append(el('div', 'qprompt', q.word.anlam), el('div', 'qhint', 'İngilizcesi hangisi?'));
    }
    const buttons = q.options.map((o) => {
      const b = el('button', 'opt', q.type === 'listen' ? o.anlam : o.word);
      b.addEventListener('click', () => {
        const ok = o.word === q.word.word;
        if (ok) right++;
        recordAnswer(q.word.word, ok);
        buttons.forEach((x, i) => {
          x.disabled = true;
          if (q.options[i].word === q.word.word) x.classList.add('ok');
        });
        if (!ok) b.classList.add('no');
        if (q.type === 'tr2en') speak(q.word.word);
        setTimeout(() => {
          if (++idx < questions.length) return showQuestion();
          const result = { date: todayStr(), score: right, total: questions.length };
          store.quiz = result;
          card.replaceWith(quizDoneLine(result));
        }, ok ? 1300 : 2200);
      });
      return b;
    });
    card.append(...buttons);
  };
  showQuestion();
  return card;
}

let loading = false;
async function renderToday() {
  renderStreak();
  const body = $('today-body');
  const today = todayStr();
  const days = store.days;
  const entry = days.find((d) => d.date === today);
  $('today-date').textContent = `✈ ${niceDate(today)}`;
  body.replaceChildren();

  if (entry) {
    const done = store.quiz;
    if (done.date === today) body.append(quizDoneLine(done));
    else {
      const questions = buildQuiz(days, store.stats, today);
      if (questions) body.append(quizCard(questions));
    }
    entry.words.forEach((w, i) => body.append(wordCard(w, i + 1, true)));
    prefetchAudio(entry.words);
    return;
  }

  const last = days[days.length - 1];
  const showLast = () => {
    if (!last) return;
    body.append(el('div', 'day', `Son kelimeler · ${niceDate(last.date)}`));
    last.words.forEach((w, i) => body.append(wordCard(w, i + 1)));
  };

  if (!store.key) {
    body.append(el('div', 'note', 'Başlamak için Gemini API anahtarını Ayarlar\'a yapıştır.'));
    const b = el('button', 'btn', 'Ayarlar\'ı aç');
    b.addEventListener('click', () => show('settings'));
    body.append(b);
    return;
  }
  if (loading) return;
  loading = true;
  body.append(el('div', 'note', 'Bugünün kelimeleri hazırlanıyor…'));
  try {
    const words = await fetchWords();
    const fresh = store.days.filter((d) => d.date !== today);
    fresh.push({ date: today, words });
    store.days = fresh;
    loading = false;
    renderToday();
  } catch (e) {
    loading = false;
    body.replaceChildren(el('div', 'note err', errorText(e)));
    const b = el('button', 'btn', 'Tekrar dene');
    b.addEventListener('click', renderToday);
    body.append(b);
    showLast();
  }
}

function renderHistory() {
  const body = $('hist-body');
  const days = store.days.slice().reverse();
  const total = days.reduce((n, d) => n + d.words.length, 0);
  $('hist-count').textContent = total ? `${total} kelime` : '';
  body.replaceChildren();
  if (!days.length) { body.append(el('div', 'note', 'Henüz kelime yok.')); return; }
  body.append(weekCard());
  days.forEach((d) => {
    body.append(el('div', 'day', niceDate(d.date)));
    d.words.forEach((w) => {
      const det = el('details', 'hist');
      const sum = el('summary');
      sum.append(el('strong', null, w.word), el('i'), el('span', null, w.anlam), playButton(w.word));
      det.append(sum);
      det.addEventListener('toggle', () => { if (det.open && det.children.length === 1) det.append(wordCard(w)); });
      body.append(det);
    });
  });
}

function renderTopics() {
  const box = $('topics');
  box.replaceChildren();
  const chosen = store.topics;
  Object.keys(TOPICS).forEach((name) => {
    const b = el('button', 'topic', name);
    b.setAttribute('aria-pressed', String(chosen.includes(name)));
    b.addEventListener('click', () => {
      const now = store.topics;
      store.topics = now.includes(name) ? now.filter((t) => t !== name) : [...now, name];
      renderTopics();
    });
    box.append(b);
  });
  $('own-topic').value = store.ownTopic;
}

function renderSettings() {
  renderTopics();
  $('key').value = store.key;
  $('key-state').textContent = store.key ? 'Anahtar kayıtlı.' : 'Henüz anahtar girilmedi.';
  renderPush();
}

function show(view) {
  ['today', 'history', 'settings'].forEach((v) => { $(`v-${v}`).hidden = v !== view; });
  document.querySelectorAll('nav button').forEach((b) => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (view === 'today') renderToday();
  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

// ---- Bildirim ------------------------------------------------------------
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function urlB64ToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function currentSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
async function renderPush() {
  const state = $('push-state'), btn = $('push-on'), out = $('push-out');
  out.hidden = true;
  btn.hidden = false;
  btn.disabled = false;
  const vapid = (window.EK_CONFIG || {}).vapidPublic;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    state.textContent = isStandalone()
      ? 'Bu cihaz bildirimi desteklemiyor (iOS 16.4 veya üstü gerekir).'
      : 'Bildirim için önce uygulamayı ana ekrana ekle: Safari\'de Paylaş → Ana Ekrana Ekle, sonra oradan aç.';
    btn.hidden = true;
    return;
  }
  if (!vapid) { state.textContent = 'Bildirim henüz kurulmadı.'; btn.hidden = true; return; }
  if (Notification.permission === 'denied') {
    state.textContent = 'Bildirim izni kapalı. iPhone Ayarlar → Bildirimler → Kelimeler\'den aç.';
    btn.hidden = true;
    return;
  }
  const sub = await currentSubscription().catch(() => null);
  if (sub) {
    state.textContent = 'Bildirimler bu telefonda açık. Kodu GitHub\'a kaydettiysen her gün hatırlatma gelir.';
    btn.textContent = 'Kodu tekrar göster';
  } else {
    state.textContent = 'Her gün bir hatırlatma bildirimi gelir.';
    btn.textContent = 'Bildirimleri aç';
  }
}
async function enablePush() {
  const state = $('push-state'), btn = $('push-on');
  btn.disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { renderPush(); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToBytes(window.EK_CONFIG.vapidPublic),
    }));
    await renderPush();
    $('push-code').value = JSON.stringify(sub);
    $('push-out').hidden = false;
  } catch (e) {
    state.textContent = 'Bildirim açılamadı: ' + (e && e.message ? e.message : 'bilinmeyen hata');
    btn.disabled = false;
  }
}

// ---- Başlangıç -----------------------------------------------------------
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
$('slow').setAttribute('aria-pressed', String(store.slow));
$('slow').addEventListener('click', () => {
  store.slow = !store.slow;
  $('slow').setAttribute('aria-pressed', String(store.slow));
});
$('key-save').addEventListener('click', () => {
  store.key = $('key').value.trim();
  renderSettings();
  if (store.key) show('today');
});
$('own-topic').addEventListener('input', () => {
  store.ownTopic = $('own-topic').value.trim().slice(0, 60);
});
$('push-on').addEventListener('click', enablePush);
$('push-copy').addEventListener('click', async () => {
  const ta = $('push-code');
  try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand('copy'); }
  $('push-copy').textContent = 'Kopyalandı ✓';
});
// Uygulama gece açık kaldıysa, yeniden öne gelince yeni günü yükle.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('v-today').hidden && !store.days.some((d) => d.date === todayStr())) renderToday();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
show('today');
