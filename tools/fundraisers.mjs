#!/usr/bin/env node
// Збори: скільки вже зібрано в monobank-банках → fundraisers.json (його читає сайт). Запускає GitHub Action
// (.github/workflows/archive.yml) раз на годину. Бере з seasons.json → support.fundraisers усі посилання
// send.monobank.ua/jar/… (крім прикладу XXXXXXXXXX), увімкнені чи ні — щоб ?check показував живі суми ще до запуску.
// Звідки суми (MONO_TOKEN чи публічна сторінка банки) — див. tools/mono.mjs. Банка не відповіла — лишаються
// останні відомі суми, а без них сайт бере raised із seasons.json. Пише файл лише тоді, коли суми змінились.
//
// Змінні середовища: MONO_TOKEN; FUNDS_OUT (куди писати, для тестів); MONO_FIXTURE (замість мережі, для тестів).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jarIdOf, ownJars, readJar, okNum, kyivStamp } from './mono.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.FUNDS_OUT || SRC);
const FILE = path.join(OUT, 'fundraisers.json');
const read = (f, def) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return def; } };
const loose = t => { try { return JSON.parse(t); } catch (e) { return JSON.parse(t.replace(/,(\s*[}\]])/g, '$1')); } };

// ── Які банки ──
const cfg = loose(read(path.join(SRC, 'seasons.json'), '{}').replace(/^﻿/, ''));
const list = cfg && cfg.support && cfg.support.fundraisers;
const jars = [...new Set([].concat(list || []).map(f => jarIdOf(f && f.url)).filter(Boolean))];

const old = (() => { try { let d = JSON.parse(read(FILE, '')); return d && typeof d.jars === 'object' ? d : null; } catch (e) { return null; } })();
if (!jars.length && !old) { console.log('Зборів з банками monobank нема — нічого робити.'); process.exit(0); }

const own = await ownJars();
let next = {};
for (const id of jars) {
    try { let j = await readJar(id, own); next[id] = { raised: j.raised, goal: j.goal, src: j.src }; }
    catch (e) {
        console.warn(`банка ${id}: не вдалось (${e.message}) — лишаю останні відомі суми`);
        if (old && old.jars[id]) next[id] = old.jars[id];
    }
}
Object.keys(next).forEach(id => { if (!okNum(next[id].raised)) delete next[id]; });   // сміття — сайт візьме raised

if (old && JSON.stringify(old.jars) === JSON.stringify(next)) { console.log(`Збори: без змін (${jars.length} банок).`); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(FILE, JSON.stringify({ updated: kyivStamp(), jars: next }, null, 2) + '\n');
console.log(`Збори: оновлено fundraisers.json (${Object.keys(next).length} з ${jars.length} банок).`);
