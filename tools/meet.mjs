#!/usr/bin/env node
// Зустрічі з бота (Гавриїл → GitHub → сайт). Запускає .github/workflows/meeting.yml; бот лише пересилає текст команди.
//
//   /zustrich                          — додати або змінити зустріч; поля — рядками «ключ: значення»:
//   дата: 14.11 19:00–21:00              дата (14.11, 14.11.2026, 2026-11-14, «14 листопада») і, за бажання, час
//   назва: Про звички й волю             для нової — обовʼязково
//   місто: Київ / місце: Книгарня «Є» / адреса: вул. Лисенка, 3
//   ціна: 300 (або «безкоштовно») / місць: 40 / опис: …
//   реєстрація: ні (без реєстрації) | так | https://… (своя форма) / мапа: https://… / запис: https://youtu.be/…
//   у шапці: ні (не показувати рядок на головній) / id: kyiv-1411 (змінити саме цю; інакше — за датою й містом)
//   «-» замість значення — прибрати поле.
//   /zustrichi                          — що зараз на сайті
//   /skasuvaty [id | 14.11 | частина назви] — скасувати (на сайті — «Скасовано», реєстрація закривається)
//   /vidnovyty [id | …]                 — повернути скасовану
//   /vydalyty [id | …]                  — прибрати з сайту зовсім
//   /oplata online | onsite             — платні: карткою через monobank (коли буде ФОП) чи на місці
//   /zustrichi_nalashtuvannia           — api: https://… (сервер Гавриїла), telegram: ІмʼяБота, оплата: onsite
//
// Змінні: MEET_TEXT (текст повідомлення), MEET_ACTION (add | list | cancel | restore | remove | payments | config — важливіша
// за команду в тексті), MEET_DATA (JSON із полями — для бота-асистента: id, date, time, title, city, place, address, fee,
// capacity, about, register, url, map, video, teaser, payments, api, telegram), MEET_MESSAGE — куди записати відповідь
// для Telegram, MEET_TODAY — «сьогодні» для тестів.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(SRC, 'seasons.json');
const read = (f, def) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return def; } };
const SITE = 'https://' + (read(path.join(SRC, 'CNAME'), 'taras.kyiv.ua').trim() || 'taras.kyiv.ua');
const env = k => String(process.env[k] || '').trim();
const pad2 = n => String(n).padStart(2, '0');
const kyivToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
const TODAY = /^\d{4}-\d{2}-\d{2}$/.test(env('MEET_TODAY')) ? env('MEET_TODAY') : kyivToday();
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const fmtDay = d => `${+d.slice(8)} ${MONTHS[+d.slice(5, 7) - 1]}${d.slice(0, 4) !== TODAY.slice(0, 4) ? ' ' + d.slice(0, 4) : ''}`;
const fmtMoney = n => new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(Math.floor(n)).replace(/\s/g, ' ') + ' ₴';
const clip = (s, n) => s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const on = v => v === true || /^(true|так|yes|1|on)$/i.test(String(v ?? '').trim());

function finish(ok, msg, commit) {
    msg = (ok ? '✅ ' : '❌ ') + msg;
    console.log(msg);
    if (env('MEET_MESSAGE')) fs.writeFileSync(env('MEET_MESSAGE'), msg + '\n');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${commit ? 1 : 0}\ncommit=${(commit || '').replace(/[\r\n]+/g, ' ')}\n`);
    process.exit(ok ? 0 : 1);
}

// ── Розбір ──
function parseDate(v) {
    let s = String(v || '').trim().toLowerCase(), m, y, mo, d;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [y, mo, d] = [+m[1], +m[2], +m[3]];
    else if ((m = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/))) [d, mo, y] = [+m[1], +m[2], m[3] ? +m[3] : 0];
    else if ((m = s.match(new RegExp(`^(\\d{1,2})\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?$`)))) [d, mo, y] = [+m[1], MONTHS.indexOf(m[2]) + 1, m[3] ? +m[3] : 0];
    else return '';
    if (y && y < 100) y += 2000;
    let guess = !y;
    if (guess) y = +TODAY.slice(0, 4);
    let t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return '';
    let out = `${y}-${pad2(mo)}-${pad2(d)}`;
    if (guess && out < TODAY) out = `${y + 1}-${pad2(mo)}-${pad2(d)}`;   // «5.01» у грудні — наступний рік
    return out;
}
// «19:00», «19.00», «о 19:00», «19:00–21:00», «з 19 до 21»
function parseTime(v) {
    let s = String(v || '').toLowerCase().replace(/^(о|об|з)\s+/, '').replace(/\s+/g, ''), m;
    if ((m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?(?:(?:[–—-]|до)(\d{1,2})(?:[:.](\d{2}))?)?$/))) {
        let a = [+m[1], +(m[2] || 0)], b = m[3] ? [+m[3], +(m[4] || 0)] : null;
        if (a[0] > 23 || a[1] > 59 || (b && (b[0] > 23 || b[1] > 59))) return null;
        return `${pad2(a[0])}:${pad2(a[1])}` + (b ? `–${pad2(b[0])}:${pad2(b[1])}` : '');
    }
    return null;
}
// Ціна: 300, «300 грн», «1 500», «безкоштовно» (0)
function money(v) {
    let s = String(v ?? '').toLowerCase().trim();
    if (/^(0|безкоштовно|безплатно|вільний|вхід вільний|free|-)$/.test(s)) return 0;
    s = s.replace(/[\s  ']/g, '').replace(/(грн|гривень|гривні|гривня|uah|₴)\.?$/, '');
    return /^\d+$/.test(s) ? +s : NaN;
}
const KEYS = { 'дата': 'date', date: 'date', 'день': 'date', 'час': 'time', time: 'time', 'назва': 'title', title: 'title', 'тема': 'title', 'місто': 'city', city: 'city',
    'місце': 'place', place: 'place', 'адреса': 'address', address: 'address', 'ціна': 'fee', 'вартість': 'fee', 'квиток': 'fee', fee: 'fee', price: 'fee',
    'місць': 'capacity', 'місця': 'capacity', 'місткість': 'capacity', capacity: 'capacity', 'опис': 'about', 'про що': 'about', about: 'about',
    'реєстрація': 'register', register: 'register', 'посилання': 'url', url: 'url', 'мапа': 'map', 'карта': 'map', map: 'map', 'запис': 'video', 'відео': 'video', video: 'video',
    'у шапці': 'teaser', 'в шапці': 'teaser', teaser: 'teaser', id: 'id', 'якір': 'id', 'оплата': 'payments', payments: 'payments', api: 'api', telegram: 'telegram', 'бот': 'telegram' };
function parseText(t) {
    let out = { rest: [] }, m;
    t = String(t || '').replace(/^\s*\/[\w@]+/, '');                      // команда бота: /zustrich, /zustrich@GavriilBot
    t.split(/\n|\|/).forEach(line => {
        line = line.trim();
        if (!line) return;
        if ((m = line.match(/^([^:：]{1,20}?)\s*[:：]\s*(.*)$/)) && KEYS[m[1].trim().toLowerCase()]) { out[KEYS[m[1].trim().toLowerCase()]] = m[2].trim(); return; }
        out.rest.push(line);
    });
    return out;
}
function fromData() {
    if (!env('MEET_DATA')) return {};
    let d;
    try { d = JSON.parse(env('MEET_DATA')); } catch (e) { finish(false, 'MEET_DATA — не JSON. Бот має передати поля як {"date": "…", "title": "…"}.'); }
    if (!isObj(d)) finish(false, 'MEET_DATA має бути обʼєктом {…}.');
    let out = {};
    Object.keys(d).forEach(k => { let key = KEYS[k.toLowerCase()] || k; if (d[k] != null && typeof d[k] !== 'object') out[key] = String(d[k]); });
    return out;
}

// Якір латиницею: «Київ» + 14.11 → kyiv-1411 (taras.kyiv.ua/#z-kyiv-1411)
const TR = { а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'io', ъ: '' };
function slug(s) {
    let out = String(s || '').toLowerCase().replace(/[ʼ'’`"]/g, '').replace(/[а-яґєіїё]/g, c => TR[c] ?? '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return out.split('-').slice(0, 3).join('-').slice(0, 24).replace(/-+$/, '');
}
const urlOk = u => /^https:\/\/[^\s"<>]+$/i.test(u);

// ── seasons.json ──
let raw = read(CFG, null);
if (raw == null) finish(false, 'Не знайшов seasons.json.');
let cfg;
try { raw = raw.replace(/^﻿/, ''); try { cfg = JSON.parse(raw); } catch (e) { cfg = JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1')); } }
catch (e) { finish(false, 'seasons.json зіпсований, і я його не чіпаю. Виправ вручну — taras.kyiv.ua/?check покаже рядок з помилкою.'); }
if (Array.isArray(cfg)) cfg = { seasons: cfg };
if (!isObj(cfg)) finish(false, 'seasons.json має бути обʼєктом {…}.');
let meet = Array.isArray(cfg.meetings) ? { enabled: true, items: cfg.meetings } : isObj(cfg.meetings) ? cfg.meetings : { enabled: true, items: [] };
if (!Array.isArray(meet.items)) meet.items = isObj(meet.items) ? [meet.items] : [];
cfg.meetings = meet;
const items = () => meet.items.filter(isObj);
const isSample = m => m.id === 'pryklad' && !on(m.enabled ?? true) || /^Приклад:/.test(String(m.title || ''));
const link = m => `${SITE}/#z-${m.id}`;
function save() { fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n'); }
function describe(m) {
    let fee = +m.fee > 0 ? fmtMoney(+m.fee) : 'безкоштовно', where = [m.city, m.place].filter(Boolean).join(', ');
    return `${fmtDay(m.date)}${m.time ? ' о ' + String(m.time).split(/[–-]/)[0] : ''}${where ? ', ' + where : ''} — «${m.title}», ${fee}` +
        (+m.capacity > 0 ? `, ${m.capacity} місць` : '') + (on(m.cancelled) ? ' — СКАСОВАНО' : '') + (m.enabled === false ? ' — вимкнено' : '');
}
function findOne(q, verb) {
    q = String(q || '').trim();
    let date = parseDate(q.replace(/^#?z-/, '')), list = items().filter(m => !isSample(m));
    let hit = !q ? list.filter(m => String(m.date) >= TODAY) : list.filter(m => String(m.id) === q.replace(/^#?z-/, '').toLowerCase() || (date && m.date === date)
        || String(m.title || '').toLowerCase().includes(q.toLowerCase()) || (q.length > 2 && String(m.city || '').toLowerCase() === q.toLowerCase()));
    if (!hit.length) finish(false, q ? `Не знайшов зустрічі «${q}».` : 'Майбутніх зустрічей нема.');
    if (hit.length > 1) finish(false, `Зустрічей кілька — уточни, яку ${verb}:\n` + hit.map(m => `• ${m.id} — ${describe(m)}`).join('\n'));
    return hit[0];
}

// ── Що робимо ──
const T = Object.assign(parseText(env('MEET_TEXT')), fromData());
const cmd = ((env('MEET_TEXT').match(/^\s*\/(\w+)/) || [])[1] || '').toLowerCase();
const ACTIONS = { add: 'add', zustrich: 'add', 'додати': 'add', list: 'list', zustrichi: 'list', 'список': 'list', cancel: 'cancel', skasuvaty: 'cancel', 'скасувати': 'cancel',
    restore: 'restore', vidnovyty: 'restore', 'відновити': 'restore', remove: 'remove', vydalyty: 'remove', 'видалити': 'remove',
    payments: 'payments', oplata: 'payments', 'оплата': 'payments', config: 'config', zustrichi_nalashtuvannia: 'config', 'налаштування': 'config' };
let action = ACTIONS[env('MEET_ACTION').toLowerCase()] || ACTIONS[cmd] || (env('MEET_ACTION') ? '' : 'add');
if (!action) finish(false, `Не знаю дії «${env('MEET_ACTION')}». Можна: add, list, cancel, restore, remove, payments, config.`);

if (action === 'list') {
    let next = items().filter(m => !isSample(m) && String(m.date) >= TODAY).sort((a, b) => String(a.date + (a.time || '')).localeCompare(String(b.date + (b.time || ''))));
    let set = `Реєстрація: ${meet.api ? 'форма на сайті' : meet.telegram ? 'через Telegram' : 'не підключено (нема api)'}; платні — ${meet.payments === 'online' ? 'карткою через monobank' : 'оплата на місці'}.`;
    if (!next.length) finish(true, `Майбутніх зустрічей на сайті нема.\n${set}`);
    finish(true, `Зустрічі на сайті (${next.length}):\n` + next.map(m => `• ${describe(m)}\n  ${link(m)}`).join('\n') + `\n${set}`);
}

if (action === 'payments' || action === 'config') {
    let p = String(T.payments || (action === 'payments' ? T.rest.join(' ') : '') || '').toLowerCase().trim(), changes = [];
    if (p) {
        let mode = /^(online|онлайн|карткою|monobank|моно)$/.test(p) ? 'online' : /^(onsite|на місці|готівкою|offline)$/.test(p) ? 'onsite' : '';
        if (!mode) finish(false, `Не розумію «${p}». Можна: /oplata online (карткою через monobank) або /oplata onsite (на місці).`);
        meet.payments = mode; changes.push(mode === 'online' ? 'платні — карткою через monobank' : 'платні — оплата на місці');
    }
    if (T.api != null) {
        let a = T.api === '-' ? '' : T.api.replace(/\/+$/, '');
        if (a && !urlOk(a)) finish(false, `api має бути адресою https://… — «${T.api}» не підходить.`);
        meet.api = a; changes.push(a ? `форма реєстрації → ${a}` : 'форму реєстрації вимкнено');
    }
    if (T.telegram != null) {
        let b = T.telegram === '-' ? '' : T.telegram.replace(/^(@|https?:\/\/t\.me\/)/i, '');
        if (b && !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(b)) finish(false, `«${T.telegram}» — не схоже на імʼя бота (латиницею, без @).`);
        meet.telegram = b; changes.push(b ? `запис у Telegram — @${b}` : 'запис у Telegram вимкнено');
    }
    if (!changes.length) finish(false, action === 'payments' ? 'Напиши, як платять: /oplata online або /oplata onsite.' : 'Нема що змінювати: api: https://…, telegram: ІмʼяБота, оплата: online | onsite.');
    if (meet.payments === 'online' && !meet.api) changes.push('⚠️ без api онлайн-оплати на сайті не буде — спершу підключи сервер Гавриїла');
    save();
    finish(true, 'Зустрічі: ' + changes.join('; ') + '.', 'зустрічі: ' + changes[0]);
}

if (action === 'cancel' || action === 'restore' || action === 'remove') {
    let q = T.id || T.rest.join(' ') || T.date || T.title || '';
    let m = findOne(q, { cancel: 'скасувати', restore: 'відновити', remove: 'прибрати' }[action]);
    if (action === 'remove') {
        meet.items = meet.items.filter(x => x !== m);
        save();
        finish(true, `Зустріч «${m.title}» (${fmtDay(m.date)}) прибрано з сайту.`, `зустріч: прибрано «${m.title}»`);
    }
    if (action === 'cancel') m.cancelled = true; else delete m.cancelled;
    save();
    finish(true, action === 'cancel' ? `Зустріч «${m.title}» (${fmtDay(m.date)}) скасовано — на сайті позначка «Скасовано», реєстрацію закрито.\n${link(m)}`
        : `Зустріч «${m.title}» (${fmtDay(m.date)}) знову на сайті.\n${link(m)}`, `зустріч: ${action === 'cancel' ? 'скасовано' : 'відновлено'} «${m.title}»`);
}

// action === 'add': нова або зміна наявної (за id, інакше — за датою й містом)
let dateIn = T.date || '', timeIn = T.time || '', m;
if (dateIn && !timeIn && (m = dateIn.match(/^(\S+(?:\s+(?:[а-яґєії]+)(?:\s+\d{4})?)?)\s+(?:о\s+|об\s+|з\s+)?(\d{1,2}[:.]\d{2}.*)$/i)) && parseDate(m[1])) [dateIn, timeIn] = [m[1], m[2]];
let date = dateIn ? parseDate(dateIn) : '';
if (dateIn && !date) finish(false, `Не розумію дату «${dateIn}». Можна так: дата: 14.11 19:00 або дата: 2026-11-14.`);
let time = timeIn && timeIn !== '-' ? parseTime(timeIn) : '';
if (timeIn && timeIn !== '-' && !time) finish(false, `Не розумію час «${timeIn}». Можна так: 19:00 або 19:00–21:00.`);
if (date && date < TODAY) finish(false, `${fmtDay(date)} уже минуло — зустріч одразу б потрапила в «Минулі».`);
let city = T.city, id = T.id ? slug(T.id.replace(/^#?z-/, '')) || T.id.replace(/^#?z-/, '').toLowerCase() : '';
let it = id ? items().find(x => String(x.id) === id) : date ? items().find(x => x.date === date && !isSample(x) && (!city || String(x.city || '').toLowerCase() === String(city).toLowerCase())) : null;
let fresh = !it;
if (fresh && !date) finish(false, 'Нема дати. Надішли так:\n/zustrich\nдата: 14.11 19:00\nназва: Про звички й волю\nмісто: Київ\nціна: 300 (або безкоштовно)');
if (fresh && !T.title) finish(false, 'Нема назви. Додай рядок «назва: …».');
if (fresh) {
    let ids = new Set(items().map(x => String(x.id || ''))), base = (slug(city || T.title) || 'zustrich') + '-' + date.slice(8) + date.slice(5, 7);
    it = { id: id || base };
    for (let n = 2; ids.has(it.id); n++) it.id = `${id || base}-${n}`;
    meet.items.push(it);
}
const put = (k, v) => { if (v === '-' || v === '') delete it[k]; else it[k] = v; };
if (date) it.date = date;
if (timeIn) put('time', timeIn === '-' ? '' : time);
for (const [k, n] of [['title', 120], ['city', 60], ['place', 120], ['address', 160], ['about', 600]]) if (T[k] != null) put(k, T[k] === '-' ? '' : clip(T[k], n));
if (T.fee != null) {
    let f = money(T.fee);
    if (!(f >= 0)) finish(false, `Не розумію ціну «${T.fee}». Пиши числом у гривнях (ціна: 300) або «безкоштовно».`);
    if (f > 0) it.fee = f; else delete it.fee;
}
if (T.capacity != null) {
    let c = T.capacity === '-' ? 0 : parseInt(String(T.capacity).replace(/\D+/g, ''), 10);
    if (T.capacity !== '-' && !(c > 0)) finish(false, `Не розумію кількість місць «${T.capacity}». Пиши числом: місць: 40.`);
    if (c > 0) it.capacity = c; else delete it.capacity;
}
if (T.register != null) {
    let r = T.register.trim();
    if (urlOk(r)) { it.url = r; delete it.register; }
    else if (/^(ні|no|false|0|без реєстрації|не треба)$/i.test(r)) { it.register = false; delete it.url; }
    else if (/^(так|yes|true|1|на сайті|-)$/i.test(r)) { delete it.register; delete it.url; }
    else finish(false, `Реєстрація: «${r}» — можна «так», «ні» або посилання https://… на свою форму.`);
}
for (const k of ['url', 'map', 'video']) if (T[k] != null) {
    let v = T[k].trim();
    if (v === '-') { delete it[k]; continue; }
    if (k === 'video' && /^[\w-]{11}$/.test(v)) v = 'https://www.youtube.com/watch?v=' + v;
    if (!urlOk(v)) finish(false, `${k === 'map' ? 'Мапа' : k === 'video' ? 'Запис' : 'Посилання'} має бути адресою https://… — «${T[k]}» не підходить.`);
    it[k] = v;
}
if (T.teaser != null) { if (/^(ні|no|false|0)$/i.test(T.teaser.trim())) it.teaser = false; else delete it.teaser; }
delete it.enabled;                                                   // увімкнено (типово)
if (!it.title) finish(false, 'Нема назви. Додай рядок «назва: …».');
meet.items = meet.items.filter(x => !isObj(x) || x === it || !isSample(x));   // приклад-заготовка більше не потрібна
if (meet.enabled === false || meet.enabled === 'false') meet.enabled = true;
meet.items.sort((a, b) => String(isObj(a) && a.date || '').localeCompare(String(isObj(b) && b.date || '')));
save();
let lines = [`Зустріч ${fresh ? 'додано' : 'оновлено'} — за хвилину-дві буде на сайті:`, describe(it), link(it)];
if (+it.fee > 0) lines.push(meet.payments === 'online' && meet.api ? 'Оплата — карткою через monobank.' : 'Оплата — на місці (онлайн-оплата: /oplata online, коли підключиш monobank).');
if (it.register !== false && !it.url && !meet.api && !meet.telegram) lines.push('⚠️ Форма реєстрації ще не підключена (нема api) — на сайті буде лише «Додати в календар».');
finish(true, lines.join('\n'), `зустріч: ${fresh ? 'додано' : 'оновлено'} «${it.title}»`);
