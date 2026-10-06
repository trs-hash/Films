#!/usr/bin/env node
// Збори: скільки вже зібрано в monobank-банках → fundraisers.json (його читає сайт). Запускає GitHub Action
// (.github/workflows/archive.yml) раз на годину. Бере з seasons.json → support.fundraisers усі посилання
// send.monobank.ua/jar/… (крім прикладу XXXXXXXXXX), увімкнені чи ні — щоб ?check показував живі суми ще до запуску.
//
// Звідки суми:
//  1) MONO_TOKEN (секрет репозиторію; особистий токен з api.monobank.ua) — офіційний API monobank:
//     /personal/client-info → jars. Лише ВЛАСНІ банки. Токен дає читати весь рахунок — тримай його тільки в Secrets.
//  2) Без токена або для чужої банки — публічна сторінка банки (неофіційно, так само, як її читає сам send.monobank.ua):
//     send.monobank.ua/api/handler → api.monobank.ua/bank/jar/…  monobank може це змінити будь-коли — тоді лишаються
//     останні відомі суми з fundraisers.json, а без них — raised із seasons.json. Сайт від цього не ламається.
// Суми monobank віддає в копійках; у файлі — гривні. Пише файл лише тоді, коли суми змінились (без зайвих комітів).
//
// Змінні середовища:
//  MONO_TOKEN     — особистий токен monobank (необовʼязково).
//  FUNDS_OUT      — куди писати (типово — корінь репозиторію). Для тестів.
//  FUNDS_FIXTURE  — JSON {"ID банки": {"raised": гривні, "goal": гривні} | "fail"} замість мережі. Для тестів.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.FUNDS_OUT || SRC);
const FILE = path.join(OUT, 'fundraisers.json');
const read = (f, def) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return def; } };
const loose = t => { try { return JSON.parse(t); } catch (e) { return JSON.parse(t.replace(/,(\s*[}\]])/g, '$1')); } };
const fixture = process.env.FUNDS_FIXTURE ? JSON.parse(read(process.env.FUNDS_FIXTURE, '{}')) : null;
const UAH = kop => Math.round(Number(kop)) / 100;
const okNum = v => typeof v === 'number' && isFinite(v) && v >= 0;

// ── Які банки ──
const cfg = loose(read(path.join(SRC, 'seasons.json'), '{}').replace(/^﻿/, ''));
const list = cfg && cfg.support && cfg.support.fundraisers;
const jars = [...new Set([].concat(list || []).map(f => {
    let m = String((f && f.url) || '').match(/send\.monobank\.ua\/jar\/([A-Za-z0-9]+)/);
    return m && !/^X+$/i.test(m[1]) ? m[1] : '';
}).filter(Boolean))];

const old = (() => { try { let d = JSON.parse(read(FILE, '')); return d && typeof d.jars === 'object' ? d : null; } catch (e) { return null; } })();
if (!jars.length && !old) { console.log('Зборів з банками monobank нема — нічого робити.'); process.exit(0); }

async function getJSON(url, opts = {}) {
    let res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(15000) }, opts));
    if (!res.ok) throw new Error(`${url.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
}

// 1) Офіційно: усі власні банки одним запитом (ліміт monobank — раз на 60 с, нам вистачає раз на годину)
async function ownJars() {
    if (fixture || !process.env.MONO_TOKEN) return {};
    try {
        let info = await getJSON('https://api.monobank.ua/personal/client-info', { headers: { 'X-Token': process.env.MONO_TOKEN } });
        let out = {};
        (info.jars || []).forEach(j => {
            let id = String(j.sendId || '').replace(/^.*jar\//, '');
            if (id && okNum(j.balance)) out[id] = { raised: UAH(j.balance), goal: okNum(j.goal) && j.goal > 0 ? UAH(j.goal) : 0, src: 'api' };
        });
        return out;
    } catch (e) { console.warn('monobank client-info:', e.message); return {}; }
}

// 2) Публічна сторінка банки
async function publicJar(id) {
    if (fixture) {
        let f = fixture[id];
        if (!f || f === 'fail') throw new Error('fixture: нема даних');
        return { raised: f.raised, goal: f.goal || 0, src: 'public' };
    }
    let hello = await getJSON('https://send.monobank.ua/api/handler', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ c: 'hello', clientId: id, Pc: crypto.randomBytes(16).toString('hex'), referer: '' }) });
    let long = hello.extJarId || hello.jarId || hello.longJarId;
    if (long) {
        try {
            let j = await getJSON('https://api.monobank.ua/bank/jar/' + encodeURIComponent(long));
            if (okNum(j.amount)) return { raised: UAH(j.amount), goal: okNum(j.goal) && j.goal > 0 ? UAH(j.goal) : 0, src: 'public' };
        } catch (e) { console.warn(`банка ${id}: bank/jar —`, e.message); }
    }
    if (okNum(hello.jarAmount)) return { raised: UAH(hello.jarAmount), goal: okNum(hello.jarGoal) && hello.jarGoal > 0 ? UAH(hello.jarGoal) : 0, src: 'public' };
    throw new Error('у відповіді нема суми');
}

const own = await ownJars();
let next = {};
for (const id of jars) {
    try { next[id] = own[id] || await publicJar(id); }
    catch (e) {
        console.warn(`банка ${id}: не вдалось (${e.message}) — лишаю останні відомі суми`);
        if (old && old.jars[id]) next[id] = old.jars[id];
    }
}
// raised/goal — числа з двома знаками; інше відкидаємо (сайт тоді візьме raised із seasons.json)
Object.keys(next).forEach(id => { if (!okNum(next[id].raised)) delete next[id]; });

function kyivStamp(now = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(now).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.timeZoneName.replace('GMT', '') || '+00:00'}`;
}
if (old && JSON.stringify(old.jars) === JSON.stringify(next)) { console.log(`Збори: без змін (${jars.length} банок).`); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(FILE, JSON.stringify({ updated: kyivStamp(), jars: next }, null, 2) + '\n');
console.log(`Збори: оновлено fundraisers.json (${Object.keys(next).length} з ${jars.length} банок).`);
