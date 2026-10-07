// Банки monobank — спільне для tools/fundraisers.mjs (суми щогодини) і tools/zbir.mjs (збір із бота).
//
// Два джерела:
//  1) MONO_TOKEN (секрет; особистий токен з api.monobank.ua) — офіційний API: /personal/client-info → jars.
//     Лише ВЛАСНІ банки. Токен дає читати весь рахунок — тримай його тільки в Secrets.
//  2) Публічна сторінка банки (неофіційно, так само, як її читає сам send.monobank.ua):
//     send.monobank.ua/api/handler → api.monobank.ua/bank/jar/…  monobank може змінити це будь-коли.
// Суми monobank віддає в копійках; тут — гривні.
// MONO_FIXTURE — JSON {"ID банки": {raised, goal, title, about} | "fail"} замість мережі (для тестів).
import fs from 'node:fs';
import crypto from 'node:crypto';

const fixture = process.env.MONO_FIXTURE ? JSON.parse(fs.readFileSync(process.env.MONO_FIXTURE, 'utf8')) : null;
const UAH = kop => Math.round(Number(kop)) / 100;
export const okNum = v => typeof v === 'number' && isFinite(v) && v >= 0;
const goalOf = g => okNum(g) && g > 0 ? UAH(g) : 0;
const text = v => typeof v === 'string' ? v.trim() : '';

// send.monobank.ua/jar/AbC123 (з https:// чи без, з ?… у хвості); bare — ще й «голий» ID. Приклад XXXXXXXXXX не рахується.
export function jarIdOf(s, bare) {
    s = String(s || '').trim();
    let m = s.match(/send\.monobank\.ua\/jar\/([A-Za-z0-9]{6,})/) || (bare ? s.match(/^([A-Za-z0-9]{6,})$/) : null);
    return m && !/^X+$/i.test(m[1]) ? m[1] : '';
}
export const jarUrl = id => 'https://send.monobank.ua/jar/' + id;

async function getJSON(url, opts = {}) {
    let res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(15000) }, opts));
    if (!res.ok) throw new Error(`${url.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
}

// Усі власні банки одним запитом (ліміт monobank — раз на 60 с). Без токена — {}.
export async function ownJars(token = process.env.MONO_TOKEN) {
    if (fixture || !token) return {};
    try {
        let info = await getJSON('https://api.monobank.ua/personal/client-info', { headers: { 'X-Token': token } });
        let out = {};
        (info.jars || []).forEach(j => {
            let id = String(j.sendId || '').replace(/^.*jar\//, '');
            if (id && okNum(j.balance)) out[id] = { raised: UAH(j.balance), goal: goalOf(j.goal), title: text(j.title), about: text(j.description), src: 'api' };
        });
        return out;
    } catch (e) { console.warn('monobank client-info:', e.message); return {}; }
}

// Одна банка за публічною сторінкою: {raised, goal, title, about}. Не вийшло — кидає помилку.
export async function publicJar(id) {
    if (fixture) {
        let f = fixture[id];
        if (!f || f === 'fail') throw new Error('банка недоступна');
        return { raised: f.raised, goal: f.goal || 0, title: f.title || '', about: f.about || '', src: 'public' };
    }
    let hello = await getJSON('https://send.monobank.ua/api/handler', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ c: 'hello', clientId: id, Pc: crypto.randomBytes(16).toString('hex'), referer: '' }) });
    let long = hello.extJarId || hello.jarId || hello.longJarId;
    if (long) {
        try {
            let j = await getJSON('https://api.monobank.ua/bank/jar/' + encodeURIComponent(long));
            if (okNum(j.amount)) return { raised: UAH(j.amount), goal: goalOf(j.goal), title: text(j.title), about: text(j.description), src: 'public' };
        } catch (e) { console.warn(`банка ${id}: bank/jar —`, e.message); }
    }
    if (okNum(hello.jarAmount)) return { raised: UAH(hello.jarAmount), goal: goalOf(hello.jarGoal), title: text(hello.jarTitle || hello.title),
        about: text(hello.jarDescription || hello.description), src: 'public' };
    throw new Error('у відповіді monobank нема суми');
}

// Спершу офіційно (якщо банка своя й є токен), інакше — публічна сторінка
export async function readJar(id, own) {
    own = own || await ownJars();
    return own[id] || publicJar(id);
}

export function kyivStamp(now = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(now).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.timeZoneName.replace('GMT', '') || '+00:00'}`;
}
