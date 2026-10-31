#!/usr/bin/env node
// Щоденник з Instagram → instagram.json (його читає сайт) і кадри posters/ig/ID.jpg. Запускає GitHub Action
// (.github/workflows/archive.yml) раз на годину, якщо в репозиторії є секрет IG_TOKEN. Без токена — нічого не робить.
//
// Джерело — Instagram API (Instagram Login): GET graph.instagram.com/me/media — усі дописи професійного акаунта.
// Беремо відео (media_type VIDEO): довгі горизонтальні (/p/КОД/) і Рілси (/reel/КОД/, media_product_type REELS,
// вертикальні) — Рілси з позначкою reel: true. Чи показувати Рілси, вирішує сайт: seasons.json → calendar.reels
// (власник, 31.10.2026: «додай Рілси — невідомо, коли будуть довгі відео в Instagram»).
// Ширину й висоту кадру записуємо (w, h) — вертикальний кадр на плитці стіни кадрується вище.
// Кадр Instagram живе на їхньому CDN лише кілька днів — тому кладемо свою копію (posters/ig/ID.jpg).
// Дата дня — за київським часом. Пише файл лише тоді, коли щось змінилось. Відео, що зникло з Instagram, —
// лишається (на те архів), поки його не прибрати з instagram.json руками.
//
// Токен: довгостроковий (60 днів). Раз на запуск просимо продовжити (refresh_access_token; Instagram дозволяє,
// коли токену ≥ 24 год). Якщо Instagram видав НОВИЙ рядок — пишемо його у файл IG_NEW_TOKEN_FILE, і той самий крок
// workflow оновлює секрет IG_TOKEN (потрібен секрет SECRETS_PAT — див. README). Той самий рядок — нічого.
//
// Змінні середовища: IG_TOKEN; IG_NEW_TOKEN_FILE; IG_OUT (куди писати, для тестів); IG_FIXTURE (JSON {media:[…], posters:{id: base64}}
// замість мережі, для тестів); IG_NO_POSTERS=1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.IG_OUT || SRC);
const FILE = path.join(OUT, 'instagram.json');
const read = (f, def) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return def; } };
const TOKEN = (process.env.IG_TOKEN || '').trim();
const fixture = process.env.IG_FIXTURE ? JSON.parse(read(process.env.IG_FIXTURE, '{}')) : null;
const API = 'https://graph.instagram.com';

if (!TOKEN && !fixture) { console.log('Instagram: нема IG_TOKEN — пропускаю (див. README → «Щоденник з Instagram»).'); process.exit(0); }

const kyivDay = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const okUrl = u => typeof u === 'string' && /^https:\/\/www\.instagram\.com\/(?:p|tv|reels?)\/[\w-]+\/?/.test(u);
// ширина й висота з маркера SOF у JPEG (щоб відрізнити горизонтальне відео від вертикального)
function jpegSize(buf) {
    for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xFF) return null;
        const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
        if (m >= 0xC0 && m <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + len;
    }
    return null;
}

async function api(url) {
    let res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    let data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
        let e = data.error || {};
        // 190 — токен недійсний / прострочений: людська підказка, що робити
        throw new Error(e.code === 190 ? 'токен Instagram недійсний або прострочений — онови секрет IG_TOKEN (README → «Щоденник з Instagram»)'
            : `Instagram ${res.status}: ${e.message || 'невідома помилка'}`);
    }
    return data;
}
async function allMedia() {
    if (fixture) return fixture.media || [];
    const FIELDS = 'id,caption,media_type,media_product_type,permalink,thumbnail_url,timestamp';
    let out = [], url = `${API}/me/media?fields=${FIELDS}&limit=50&access_token=${encodeURIComponent(TOKEN)}`;
    for (let page = 0; url && page < 40; page++) {             // до 2000 дописів — із запасом на роки щоденника
        let data = await api(url);
        out.push(...(data.data || []));
        url = data.paging && data.paging.next || '';
    }
    return out;
}
async function poster(m) {
    let rel = `posters/ig/${m.id}.jpg`, f = path.join(OUT, rel);
    if (fs.existsSync(f)) return { rel, buf: fs.readFileSync(f) };
    if (process.env.IG_NO_POSTERS) return { rel: '', buf: null };
    let buf = null;
    if (fixture) buf = fixture.posters && fixture.posters[m.id] ? Buffer.from(fixture.posters[m.id], 'base64') : null;
    else if (m.thumbnail_url) {
        try { let res = await fetch(m.thumbnail_url, { signal: AbortSignal.timeout(20000) }); if (res.ok) buf = Buffer.from(await res.arrayBuffer()); } catch (e) {}
    }
    if (!buf || buf[0] !== 0xFF || buf[1] !== 0xD8) return { rel: '', buf: null };   // не JPEG — не кладемо
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, buf);
    changed.push(rel);
    return { rel, buf };
}

let changed = [];
const old = (() => { try { let d = JSON.parse(read(FILE, '')); return d && Array.isArray(d.items) ? d : null; } catch (e) { return null; } })();
const byId = new Map((old ? old.items : []).filter(it => it && it.id).map(it => [String(it.id), it]));

let media;
try { media = await allMedia(); }
catch (e) { console.error('Instagram: ' + e.message); process.exit(1); }

for (const m of media) {
    if (!m || m.media_type !== 'VIDEO' || !okUrl(m.permalink) || !m.timestamp || isNaN(new Date(m.timestamp))) continue;
    let id = String(m.id).replace(/[^\w-]/g, ''); if (!id) continue;
    let p = await poster(Object.assign({}, m, { id }));
    let size = p.buf ? jpegSize(p.buf) : null;
    let it = { id, url: m.permalink.replace(/[?#].*$/, ''), date: kyivDay(m.timestamp), ts: m.timestamp, caption: String(m.caption || '').slice(0, 2200) };
    if (m.media_product_type === 'REELS' || /\/reels?\//.test(it.url) || (size && size.w < size.h)) it.reel = true;
    if (p.rel) it.poster = p.rel;
    if (size) { it.w = size.w; it.h = size.h; }
    byId.set(id, Object.assign({}, byId.get(id) || {}, it));
}
const items = [...byId.values()].sort((a, b) => a.ts < b.ts ? -1 : 1);
if (!old || JSON.stringify(old.items) !== JSON.stringify(items) || old.skipped) {
    fs.writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), items }, null, 2) + '\n');
    changed.push('instagram.json');
}
console.log(`Instagram: відео ${items.length} (з них Рілсів ${items.filter(it => it.reel).length}); змінено файлів: ${changed.length}`);

// ── Продовжити токен (60 днів від сьогодні). Новий рядок — у GITHUB_OUTPUT для кроку, що оновлює секрет ──
if (!fixture && TOKEN) {
    try {
        let r = await api(`${API}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(TOKEN)}`);
        let days = Math.round((+r.expires_in || 0) / 86400);
        if (r.access_token && r.access_token !== TOKEN && process.env.IG_NEW_TOKEN_FILE) {
            console.log(`::add-mask::${r.access_token}`);
            fs.writeFileSync(process.env.IG_NEW_TOKEN_FILE, r.access_token, { mode: 0o600 });
            console.log(`Токен Instagram продовжено (новий, діє ще ~${days} днів) — оновлюю секрет.`);
        } else console.log(`Токен Instagram продовжено: діє ще ~${days} днів.`);
    } catch (e) { console.log('Токен Instagram не продовжено (так буває, якщо йому < 24 год): ' + e.message); }
}
