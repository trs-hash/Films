#!/usr/bin/env node
// Збір із бота (Гавриїл → GitHub → сайт). Запускає .github/workflows/fundraiser.yml; бот лише пересилає текст команди.
//
//   /zbir https://send.monobank.ua/jar/AbC123xyz          — додати збір: назву, опис і ціль бере з самої банки
//   /zbir https://send.monobank.ua/jar/AbC123xyz
//   Дрон для бригади                                       — 1-й рядок — назва, далі — опис
//   Збираємо на мавік для побратимів.
//   ціль 50000, до 31.12, благодійний                      — необовʼязково; те саме можна через « | » в один рядок
//   /zakryty [dron | посилання | частина назви]            — закрити (без уточнення — єдиний активний)
//   /zbory                                                  — що зараз на сайті
//
// Повторний /zbir з тією самою банкою оновлює збір, а не дублює. Змінює лише seasons.json → support:
// вмикає support.enabled і сам збір; «Стати спонсором» / «Підтримати», які глядачі досі не бачили, так і лишаються
// невидимими. Приклад-заготовку (…/jar/XXXXXXXXXX) прибирає.
//
// Змінні: ZBIR_ACTION (add | close | list; можна й командою в тексті), ZBIR_TEXT (текст повідомлення),
// ZBIR_URL, ZBIR_TITLE, ZBIR_ABOUT, ZBIR_GOAL, ZBIR_UNTIL, ZBIR_KIND — те саме окремими полями (форма в GitHub),
// ZBIR_MESSAGE — куди записати відповідь для Telegram, ZBIR_TODAY — «сьогодні» для тестів; MONO_TOKEN, MONO_FIXTURE.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jarIdOf, jarUrl, readJar } from './mono.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(SRC, 'seasons.json');
const read = (f, def) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return def; } };
const SITE = 'https://' + (read(path.join(SRC, 'CNAME'), 'taras.kyiv.ua').trim() || 'taras.kyiv.ua');
const env = k => String(process.env[k] || '').trim();
const pad2 = n => String(n).padStart(2, '0');
const kyivToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
const TODAY = /^\d{4}-\d{2}-\d{2}$/.test(env('ZBIR_TODAY')) ? env('ZBIR_TODAY') : kyivToday();
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const fmtDay = d => `${+d.slice(8)} ${MONTHS[+d.slice(5, 7) - 1]}${d.slice(0, 4) !== TODAY.slice(0, 4) ? ' ' + d.slice(0, 4) : ''}`;
const fmtMoney = n => new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(Math.floor(n)).replace(/\s/g, ' ') + ' ₴';
const clip = (s, n) => s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;

// ── Відповідь боту й вихід ──
function finish(ok, msg, commit) {
    msg = (ok ? '✅ ' : '❌ ') + msg;
    console.log(msg);
    if (env('ZBIR_MESSAGE')) fs.writeFileSync(env('ZBIR_MESSAGE'), msg + '\n');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${commit ? 1 : 0}\ncommit=${(commit || '').replace(/[\r\n]+/g, ' ')}\n`);
    process.exit(ok ? 0 : 1);
}

// ── Розбір тексту ──
// Суми: 50000, «50 000 грн», «50к», «50 тис», «1 500,50»
function money(v) {
    let s = String(v || '').toLowerCase().replace(/[\s  ']/g, '').replace(/(грн|гривень|гривні|гривня|uah|₴)\.?$/, ''), k = 1, m;
    if ((m = s.match(/^(.+?)(k|к|тис\.?|тисяч)$/))) { s = m[1]; k = 1000; }
    if (/^\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, '');
    s = s.replace(',', '.');
    return /^\d+(\.\d+)?$/.test(s) ? Math.round(parseFloat(s) * k * 100) / 100 : NaN;
}
const MONEY_RE = '(?:\\d{1,3}(?:[\\s.,]\\d{3})+(?:,\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)(?:\\s*(?:к|k|тис\\.?|тисяч))?(?:\\s*(?:грн|₴|uah))?';
// Дати: 2026-12-31, 31.12.2026, 31.12.26, 31.12 (найближче таке число), «31 грудня [2026]»
const DATE_RE = `\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[./]\\d{1,2}(?:[./]\\d{2,4})?|\\d{1,2}\\s+(?:${MONTHS.join('|')})(?:\\s+\\d{4})?`;
function parseDate(v) {
    let s = String(v || '').trim().toLowerCase(), m, y, mo, d;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [y, mo, d] = [+m[1], +m[2], +m[3]];
    else if ((m = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/))) [d, mo, y] = [+m[1], +m[2], m[3] ? +m[3] : 0];
    else if ((m = s.match(new RegExp(`^(\\d{1,2})\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?$`)))) [d, mo, y] = [+m[1], MONTHS.indexOf(m[2]) + 1, m[3] ? +m[3] : 0];
    else return '';
    if (y && y < 100) y += 2000;
    let guess = !y, ty = +TODAY.slice(0, 4);
    if (guess) y = ty;
    let t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return '';
    let out = `${y}-${pad2(mo)}-${pad2(d)}`;
    if (guess && out < TODAY) out = `${y + 1}-${pad2(mo)}-${pad2(d)}`;   // «до 15.01» у грудні — це наступний рік
    return out;
}
function parseText(t) {
    let out = { rest: [] }, m;
    t = String(t || '').replace(/^\s*\/[\w@]+/, '');                     // команда бота: /zbir, /zbir@GavriilBot
    t.split(/\n|\|/).forEach(part => {
        part = part.trim();
        if ((m = part.match(/(?:https?:\/\/)?send\.monobank\.ua\/jar\/[A-Za-z0-9]+[^\s,;]*/))) { out.url = out.url || m[0]; part = part.replace(m[0], ''); }
        if ((m = part.match(new RegExp(`(?:^|[\\s,;])(?:ціль|мета|сума|goal)\\s*[:\\-–—]?\\s*(${MONEY_RE})(?=$|[\\s,;])`, 'i')))) { out.goal = m[1]; part = part.replace(m[0], ' '); }
        if ((m = part.match(new RegExp(`(?:^|[\\s,;])(?:до|по|until|термін)\\s*[:\\-–—]?\\s*(${DATE_RE})(?=$|[\\s,;])`, 'i')))) { out.until = m[1]; part = part.replace(m[0], ' '); }
        part = part.replace(/^[\s,;:—–-]+|[\s,;:—–-]+$/g, '').replace(/\s{2,}/g, ' ');
        if (!part) return;
        if (/^(благодійн\S*|charity)(\s+збір)?$/i.test(part)) { out.kind = 'charity'; return; }
        if (/^(на\s+канал|канал|channel)$/i.test(part)) { out.kind = 'channel'; return; }
        if (!out.goal && new RegExp(`^${MONEY_RE}$`, 'i').test(part)) { out.goal = part; return; }
        out.rest.push(part);
    });
    return out;
}
const KINDS = { charity: 'charity', 'благодійний': 'charity', 'благодійність': 'charity', channel: 'channel', 'канал': 'channel', 'на канал': 'channel' };

// Якір збору латиницею: «Дрон для бригади» → dron-dlia-bryhady (taras.kyiv.ua/#f-dron-dlia-bryhady)
const TR = { а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'io', ъ: '' };
function slug(s) {
    let out = String(s || '').toLowerCase().replace(/[ʼ'’`"]/g, '').replace(/[а-яґєіїё]/g, c => TR[c] ?? '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return out.split('-').slice(0, 4).join('-').slice(0, 32).replace(/-+$/, '');
}

// ── seasons.json ──
let raw = read(CFG, null);
if (raw == null) finish(false, 'Не знайшов seasons.json.');
let cfg;
try { raw = raw.replace(/^﻿/, ''); try { cfg = JSON.parse(raw); } catch (e) { cfg = JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1')); } }
catch (e) { finish(false, 'seasons.json зіпсований, і я його не чіпаю. Виправ вручну — taras.kyiv.ua/?check покаже рядок з помилкою.'); }
if (Array.isArray(cfg)) cfg = { seasons: cfg };                       // найстаріший формат — просто список сезонів
if (!cfg || typeof cfg !== 'object') finish(false, 'seasons.json має бути обʼєктом {…}.');
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
let sup = isObj(cfg.support) ? cfg.support : (cfg.support = {});
let funds = Array.isArray(sup.fundraisers) ? sup.fundraisers : isObj(sup.fundraisers) ? [sup.fundraisers] : [];
sup.fundraisers = funds;
const on = v => v === true || /^(true|так|yes|1|on)$/i.test(String(v ?? '').trim());
const isSample = f => /send\.monobank\.ua\/jar\/X+(?:$|[/?#])/i.test(String(f && f.url || ''));
const active = f => isObj(f) && on(f.enabled) && on(sup.enabled) && f.title && f.url && !isSample(f) && !(f.until && String(f.until) < TODAY);
const liveSums = (() => { try { return JSON.parse(read(path.join(SRC, 'fundraisers.json'), '{}')).jars || {}; } catch (e) { return {}; } })();
function sumsOf(f) {
    let l = liveSums[jarIdOf(f.url)], raised = l && typeof l.raised === 'number' ? l.raised : +f.raised || 0, goal = +f.goal || (l && +l.goal) || 0;
    return goal ? `${fmtMoney(raised)} з ${fmtMoney(goal)} (${Math.floor(raised / goal * 100)}%)` : `зібрано ${fmtMoney(raised)}`;
}
const link = f => `${SITE}/#f-${f.id}`;
function save() { fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n'); }

// ── Що робимо ──
const T = parseText(env('ZBIR_TEXT'));
let action = env('ZBIR_ACTION').toLowerCase();
const cmd = (env('ZBIR_TEXT').match(/^\s*\/([\w]+)/) || [])[1] || '';
const ACTIONS = { add: 'add', 'додати': 'add', zbir: 'add', 'збір': 'add', close: 'close', 'закрити': 'close', zakryty: 'close', zakryt: 'close',
    list: 'list', 'список': 'list', 'збори': 'list', zbory: 'list' };
action = ACTIONS[action] || ACTIONS[cmd.toLowerCase()] || (action ? '' : 'add');
if (!action) finish(false, `Не знаю дії «${env('ZBIR_ACTION')}». Можна: add (додати), close (закрити), list (показати).`);

if (action === 'list') {
    let act = funds.filter(active);
    let late = funds.filter(f => isObj(f) && on(f.enabled) && f.until && String(f.until) < TODAY && !isSample(f));
    if (!act.length) finish(true, 'Зараз на сайті нема жодного збору.' + (late.length ? ` Термін минув: ${late.map(f => '«' + f.title + '»').join(', ')}.` : ''));
    finish(true, `На сайті ${act.length === 1 ? 'один збір' : act.length + ' збори'}:\n` + act.map(f =>
        `• ${f.title} — ${sumsOf(f)}${f.until ? ', до ' + fmtDay(String(f.until)) : ''}\n  ${link(f)}`).join('\n'));
}

if (action === 'close') {
    let q = (T.url || T.rest.join(' ') || env('ZBIR_URL') || env('ZBIR_TITLE')).trim(), jar = jarIdOf(q, true), list = funds.filter(f => isObj(f) && on(f.enabled) && !isSample(f));
    let hit = !q ? list : list.filter(f => (jar && jarIdOf(f.url) === jar) || String(f.id) === q.replace(/^#?f-/, '').toLowerCase()
        || String(f.title || '').toLowerCase().includes(q.toLowerCase()));
    if (!hit.length) finish(false, q ? `Не знайшов відкритого збору «${q}».` : 'Відкритих зборів нема — нічого закривати.');
    if (hit.length > 1) finish(false, 'Відкритих зборів кілька — уточни, який закрити:\n' + hit.map(f => `• /zakryty ${f.id} — ${f.title}`).join('\n'));
    let f = hit[0];
    f.enabled = false;
    save();
    finish(true, `Збір «${f.title}» закрито — на сайті його більше нема. Підсумок: ${sumsOf(f)}.`, `збір: закрито «${f.title}»`);
}

// action === 'add'
let url = T.url || env('ZBIR_URL'), jar = jarIdOf(url, true);
if (!jar) finish(false, (url ? `«${url}» — не посилання на банку monobank.` : 'Нема посилання на банку.') +
    ' Надішли так: /zbir https://send.monobank.ua/jar/…  (назва — другим рядком, якщо треба інша).');
let title = env('ZBIR_TITLE') || T.rest[0] || '', about = env('ZBIR_ABOUT') || T.rest.slice(1).join(' ');
let goalIn = env('ZBIR_GOAL') || T.goal || '', untilIn = env('ZBIR_UNTIL') || T.until || '', kindIn = (env('ZBIR_KIND') || T.kind || '').toLowerCase();
let goal = goalIn ? money(goalIn) : 0;
if (goalIn && !(goal > 0)) finish(false, `Не розумію ціль «${goalIn}». Пиши числом у гривнях: ціль 50000.`);
let until = untilIn ? parseDate(untilIn) : '';
if (untilIn && !until) finish(false, `Не розумію дату «${untilIn}». Можна так: до 31.12 або до 2026-12-31.`);
if (until && until < TODAY) finish(false, `Дата ${fmtDay(until)} вже минула — збір одразу б зник із сайту.`);
let kind = kindIn ? KINDS[kindIn] : '';
if (kindIn && !kind) finish(false, `Не знаю вид збору «${kindIn}». Можна: благодійний або на канал.`);

let info = null;
try { info = await readJar(jar); } catch (e) { console.warn(`банка ${jar}: ${e.message}`); }
let f = funds.find(x => isObj(x) && jarIdOf(x.url) === jar), fresh = !f;
title = clip(title || (f && f.title) || (info && info.title) || '', 120);
if (!title) finish(false, `Не вдалось прочитати банку ${jarUrl(jar)} у monobank, тож не знаю назви. Надішли назву другим рядком:\n/zbir ${jarUrl(jar)}\nДрон для бригади`);
about = clip(about || (f && f.about) || (info && info.about) || '', 400);

if (fresh) {
    let ids = new Set(funds.filter(isObj).map(x => String(x.id || ''))), base = slug(title) || 'zbir', id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    f = { enabled: true, id, title, about, url: jarUrl(jar), goal: 0, raised: 0, until: '', kind: '' };
    funds.unshift(f);                                                 // найновіший — першим на сайті
}
Object.assign(f, { enabled: true, title, about, url: jarUrl(jar) });
if (goal) f.goal = goal; else if (!+f.goal && info && info.goal) f.goal = info.goal;
if (until) f.until = until;
if (kind) f.kind = kind;
if (info) { f.raised = info.raised; delete liveSums[jar]; }           // знімок суми: видно одразу, далі оновлює fundraisers.json
if (!f.id) f.id = slug(title) || 'zbir';
sup.fundraisers = funds.filter(x => !isSample(x));                     // приклад-заготовка більше не потрібна

// Вмикаємо весь блок підтримки — але глядачі мають побачити лише збір, а не те, що досі ховалось за вимкненим блоком
let hidden = [];
if (!on(sup.enabled)) {
    [['membership', 'Стати спонсором'], ['donate', 'Підтримати']].forEach(([k, name]) => {
        if (isObj(sup[k]) && on(sup[k].enabled)) { sup[k].enabled = false; hidden.push(`«${sup[k].label || name}»`); }
    });
    sup.enabled = true;
}
save();
let lines = [`Збір «${title}» ${fresh ? 'додано' : 'оновлено'} — за хвилину-дві буде на сайті:`, link(f),
    info ? `Зараз: ${sumsOf(f)}${f.until ? ', до ' + fmtDay(String(f.until)) : ''}.`
        : `Суму з банки поки не прочитав — підтягнеться автоматично протягом години${f.until ? '; до ' + fmtDay(String(f.until)) : ''}.`];
if (hidden.length) lines.push(`${hidden.join(' і ')} лишаю вимкненим — це вмикається лише вручну.`);
finish(true, lines.join('\n'), `збір: ${fresh ? 'додано' : 'оновлено'} «${title}»`);
