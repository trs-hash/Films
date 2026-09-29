// QA + «human error» прогін сезонної сторінки: headless Chromium, підмінні відповіді YouTube / JSON.
// Кожен кейс — сценарій + перевірки. Вихід: таблиця PASS/FAIL, скриншоти — у tests/qa-shots/.
// Запуск:  node tests/qa.js            (усі кейси)
//          node tests/qa.js 'H0[1-5]'  (лише ті, що підходять під регулярний вираз)
// Потрібен playwright (npm i -g playwright або npx playwright install chromium).
const http = require('http'), fs = require('fs'), path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const EXE = fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'qa-shots');
fs.mkdirSync(OUT, { recursive: true });
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let f = path.join(ROOT, p);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(f));
}).listen(8766);

// ── Фабрики даних ────────────────────────────────────────────────────────────
const thumb = c => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="100%" height="100%" fill="${c}"/></svg>`);
const vid = (id, title, pub, desc = '', o = {}) => ({
  snippet: { title, description: desc, resourceId: { videoId: id }, thumbnails: o.noThumb ? {} : { maxres: { url: thumb('#5a6b7c') } } },
  contentDetails: { videoId: id, videoPublishedAt: pub },
  status: { privacyStatus: o.status || 'public' },
});
const priv = id => ({ snippet: { title: 'Private video', description: 'This video is private.', resourceId: { videoId: id }, thumbnails: {} },
  contentDetails: { videoId: id }, status: { privacyStatus: 'private' } });
const deleted = id => ({ snippet: { title: 'Deleted video', description: 'This video is unavailable.', resourceId: { videoId: id }, thumbnails: {} },
  contentDetails: { videoId: id }, status: { privacyStatus: 'privacyStatusUnspecified' } });
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
// 120 щоденних відео (1 червня … 28 вересня), як їх віддає список завантажень: найновіші першими, по 50 на сторінку
const DAILY120 = Array.from({ length: 120 }, (_, i) => vid('d' + i, 'День ' + i, new Date(Date.UTC(2026, 5, 1 + i, 10)).toISOString())).reverse();
const pagedApi = (list, extra = {}) => (pid, tok) => {
  if (pid !== 'UU1') return extra[pid] || [];
  let p = +(tok || 0), items = list.slice(p * 50, p * 50 + 50);
  return (p + 1) * 50 < list.length ? { items, nextPageToken: String(p + 1) } : { items };
};
// Кеш «повторного візиту»: те, що сайт сам зберігає в localStorage
const cacheInit = (fullAgeMs) => `(() => { try {
  const recs = ${JSON.stringify(Array.from({ length: 120 }, (_, i) => { const d = new Date(Date.UTC(2026, 5, 1 + i, 10)); return { key: 'd' + i, title: 'День ' + i, y: 'd' + i, v: '', imp: false, tags: [], date: d.toISOString().slice(0, 10), ts: d.toISOString(), thumb: '', srcset: '' }; }).reverse())};
  localStorage.setItem('ss_seasons', JSON.stringify({ calendar: { start: '2026-05-01', playlist: 'UU1', exclude: ['SH'] } }));
  localStorage.setItem('ss_pl', JSON.stringify({ UU1: recs, SH: [] }));
  localStorage.setItem('ss_meta', '{}'); localStorage.setItem('ss_time', String(Date.now()));
  localStorage.setItem('ss_full', String(Date.now() - ${fullAgeMs}));
} catch (e) {} })()`;

// Головна: календар з усіх завантажень (UU1) без Shorts (SH)
const CAL = (o = {}) => ({ calendar: Object.assign({ start: '2026-09-01', playlist: 'UU1', exclude: ['SH'] }, o) });
const S1 = (o = {}) => Object.assign({ n: 1, title: 'Тема', about: 'Опис', start: '2026-09-20', end: '2026-12-20', schedule: 'Нова серія щотижня', playlist: 'PL1', episodes: null, support: '' }, o);
// Відео з реальним набором мініатюр (як віддає API: medium/high/standard/maxres з шириною)
// Окремі адреси на кожен розмір, як у YouTube (однакова картинка з різним #… браузер вважає вже завантаженою)
const TFILE = { medium: 'mqdefault', high: 'hqdefault', standard: 'sddefault', maxres: 'maxresdefault' };
const vidT = (id, title, pub) => { let v = vid(id, title, pub); v.snippet.thumbnails = Object.fromEntries([['medium', 320], ['high', 480], ['standard', 640], ['maxres', 1280]].map(([k, w]) => [k, { url: `https://i.ytimg.com/vi/${id}/${TFILE[k]}.jpg`, width: w, height: w * 9 / 16 }])); return v; };
// Відео з хештегами: #подорожі ×3 (в описі, в назві, у ВЕРХНЬОМУ регістрі), #книги ×1; сміття — #1, якір у посиланні, #shorts
const TAGGED = [
  vid('g1', 'Перше', '2026-09-21T10:00:00Z', 'Сьогодні в дорозі #подорожі #книги'),
  vid('g2', 'Друге', '2026-09-22T10:00:00Z', 'Опис'),
  vid('g3', 'Третє', '2026-09-23T10:00:00Z', '#ПОДОРОЖІ, серія #1, https://x.com/#top #shorts'),
  vid('g4', 'Без тем', '2026-09-24T10:00:00Z', 'просто день'),
];
TAGGED[1].snippet.title = 'Друге #подорожі';   // хештег у назві теж рахується
const TWO = [vid('a1', 'Перша', '2026-09-20T15:00:00Z', 'Записка 1'), vid('a2', 'Друга', '2026-09-27T15:00:00Z', '№ Важлива\n\n🕒 18:00 27/09/2026')];

// ── Запуск одного сценарію ──────────────────────────────────────────────────
async function scenario(browser, o) {
  const ctx = await browser.newContext({ viewport: o.viewport || { width: 1280, height: 900 }, deviceScaleFactor: o.dpr || 1, userAgent: o.ua, hasTouch: !!o.ua, isMobile: !!o.mobile,
    storageState: o.storageState, colorScheme: o.dark ? 'dark' : 'light', timezoneId: o.tz || 'Europe/Kyiv' });
  const page = await ctx.newPage();
  const errs = [], warns = [], apiCalls = [], apiUrls = [], fileUrls = [];
  page.on('request', q => { if (/localhost:8766\/.*\.json/.test(q.url())) fileUrls.push(q.url()); });
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'warning') warns.push(m.text()); });
  if (o.initScript) await page.addInitScript(o.initScript);
  await page.addInitScript(() => { window.openApp = u => { window.__opened = u; }; });   // перехоплюємо відкриття застосунку
  await ctx.route(/googleapis\.com/, async r => {
    apiUrls.push(r.request().url());
    if (o.apiDelay) await new Promise(res => setTimeout(res, o.apiDelay));
    const pid = new URL(r.request().url()).searchParams.get('playlistId'), tok = new URL(r.request().url()).searchParams.get('pageToken');
    apiCalls.push(pid);
    const a = typeof o.api === 'function' ? o.api(pid, tok) : (o.api || {})[pid];
    if (a === 'quota') return r.fulfill({ status: 403, contentType: 'application/json', body: '{"error":{"code":403,"message":"quota","errors":[{"reason":"quotaExceeded"}]}}' });
    if (a === 'abort') return r.abort();
    if (a === undefined || a === '404') return r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":404,"message":"The playlist identified with the request\'s playlistId parameter cannot be found.","errors":[{"reason":"playlistNotFound"}]}}' });
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify(Array.isArray(a) ? { items: a } : a) });
  });
  await ctx.route(/i\.ytimg\.com/, r => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="100%" height="100%" fill="#5a6b7c"/></svg>' }));
  await ctx.route(/youtube\.com\/watch/, r => r.fulfill({ body: '<title>YouTube</title>watch', contentType: 'text/html' }));
  await ctx.route(/youtube\.com\/embed/, r => r.fulfill({ body: '<body style="background:#000"></body>', contentType: 'text/html' }));
  const json = (pat, v) => ctx.route(pat, r => v === 404 ? r.fulfill({ status: 404 })
    : r.fulfill({ contentType: 'application/json', body: typeof v === 'string' ? v : JSON.stringify(v) }));
  if (o.seasons !== undefined) await json(/seasons\.json/, o.seasons);
  await json(/archive\.json/, o.archive !== undefined ? o.archive : { base: '', days: {} });
  if (o.state !== undefined) await json(/state\.json/, o.state);
  await page.goto('http://localhost:8766/' + (o.path || ''));
  await page.waitForTimeout(o.wait || 700);
  if (o.reload) { await o.reload(page); }
  const r = { page, ctx, browser, o, errs, warns, apiCalls, apiUrls, fileUrls, text: (await page.innerText('body')).replace(/\s+/g, ' ') };
  if (o.shot) await page.screenshot({ path: `${OUT}/${o.shot}.png`, fullPage: true });
  return { r, ctx };
}

// ── Кейси ────────────────────────────────────────────────────────────────────
const has = (r, s) => r.text.toLowerCase().includes(s.toLowerCase());
const CASES = [
  // --- Базовий функціонал
  ['F01 реальний стан: 2 приватні відео → без «0 серій», є «Перша серія»', { seasons: { seasons: [S1({ title: '' })] }, api: { PL1: [priv('x1'), priv('x2')] }, shot: 'F01' },
    r => has(r, 'Сезон 1') && !has(r, '0 серій') && has(r, 'Перша серія') && has(r, 'Тиждень 2 з 13')],
  ['F02 дві публічні серії, № → зірка, «Нова» на останній', { seasons: { seasons: [S1()] }, api: { PL1: TWO }, shot: 'F02' },
    async r => has(r, '2 серії') && has(r, 'Серія 02 · 27 вересня') && has(r, 'Наступна серія')
      && await r.page.locator('.ep .star').count() === 1 && await r.page.locator('.ep-new').count() === 1],
  ['F03 модалка: записка без №, штамп часу, зупинка відео при закритті', { seasons: { seasons: [S1()] }, api: { PL1: TWO } },
    async r => { await r.page.click('.ep:nth-child(2)'); await r.page.waitForTimeout(200);
      let t = await r.page.innerText('#modNote'), src = await r.page.getAttribute('#ytIframe', 'src');
      await r.page.keyboard.press('Escape'); let src2 = await r.page.getAttribute('#ytIframe', 'src');
      return t.includes('Важлива') && !t.includes('№') && t.includes('18:00 27/09/2026') && src.includes('/embed/a2') && !src2; }],
  ['F04 переглянуте зберігається після перезавантаження', { seasons: { seasons: [S1()] }, api: { PL1: TWO },
      reload: async p => { await p.click('.ep:nth-child(1)'); await p.keyboard.press('Escape'); await p.reload(); await p.waitForTimeout(600); } },
    async r => await r.page.locator('.ep.watched').count() === 1],
  ['F05 видалене відео й «unlisted»: видалене сховане, unlisted видно', { seasons: { seasons: [S1()] }, api: { PL1: [deleted('d1'), vid('u1', 'Unlisted', '2026-09-21T10:00:00Z', '', { status: 'unlisted' })] } },
    r => has(r, 'Unlisted') && !has(r, 'Deleted video') && has(r, '1 серія')],
  ['F06 пагінація: 60 серій у плейлисті', { seasons: { seasons: [S1({ end: '2027-12-31' })] },
      api: (pid, tok) => { let all = Array.from({ length: 60 }, (_, i) => vid('p' + i, 'Серія ' + i, new Date(Date.UTC(2026, 8, 20) + i * 36e5).toISOString())); return tok ? { items: all.slice(50) } : { items: all.slice(0, 50), nextPageToken: 'T2' }; } },
    r => has(r, '60 серій')],
  ['F07 кілька сезонів: поточний → анонс → завершений; навігація', { seasons: { seasons: [S1({ n: 0, title: 'Пілот', start: '2026-07-01', end: '2026-08-31', playlist: 'PL0' }), S1(), S1({ n: 2, title: 'Наступна тема', start: '2027-01-10', end: '2027-04-04', playlist: 'PL2' })] },
      api: { PL0: [vid('z1', 'Пілот 1', '2026-07-05T10:00:00Z')], PL1: TWO, PL2: [] }, shot: 'F07' },
    async r => { let ids = await r.page.$$eval('section.season', s => s.map(x => x.id)); return ids.join() === 's-1,s-2,s-0' && await r.page.locator('.nav-seg').count() === 3 && has(r, 'Старт — 10 січня 2027') && has(r, 'Завершено'); }],
  ['F08 заплановано episodes=2 і обидві вийшли → нема «наступної»', { seasons: { seasons: [S1({ episodes: 2 })] }, api: { PL1: TWO } },
    async r => has(r, 'Серій: 2 / 2') && await r.page.locator('.ep.next').count() === 0],
  ['F09 режим doomsday: серії з archive.json по датах сезону', { state: { mode: 'doomsday' }, seasons: { seasons: [S1()] },
      archive: { base: '', days: { '2026-09-20': [{ t: 'Архівна', p: thumb('#7a5'), y: 'a1', desc: 'з архіву' }], '2026-06-01': [{ t: 'Поза сезоном', y: 'zz' }] } } },
    r => has(r, 'Архівна') && !has(r, 'Поза сезоном') && has(r, '1 серія')],
  ['F10 YouTube: квота вичерпана → авто-фолбек на архів', { seasons: { seasons: [S1()] }, api: { PL1: 'quota' },
      archive: { base: '', days: { '2026-09-27': [{ t: 'З архіву', y: 'a2' }] } } },
    r => has(r, 'З архіву')],
  ['F11 усе впало → сезон видно + повідомлення', { seasons: { seasons: [S1()] }, api: { PL1: 'abort' }, archive: 404 },
    r => has(r, 'Тема') && has(r, 'Не вдалось завантажити серії')],
  ['F12 темна тема без помилок', { seasons: { seasons: [S1()] }, api: { PL1: TWO }, dark: true, shot: 'F12-dark' },
    async r => (await r.page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(18, 18, 18)'],
  ['F13 мобільний 320px: без горизонтального скролу', { seasons: { seasons: [S1({ title: 'Дуже-довга-назва-без-пробілів-яка-не-влазить-у-рядок' })] }, api: { PL1: TWO }, viewport: { width: 320, height: 700 }, shot: 'F13-320' },
    async r => await r.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)],
  ['F14 12 сезонів: навігація не ламає ширину (мобільний)', { seasons: { seasons: Array.from({ length: 12 }, (_, i) => S1({ n: i + 1, start: `2025-${String(i + 1).padStart(2, '0')}-01`, end: `2025-${String(i + 1).padStart(2, '0')}-20`, playlist: '' })) }, viewport: { width: 390, height: 800 }, shot: 'F14' },
    async r => await r.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)],
  ['F15 calendar.html (архів макету) відкривається без помилок', { path: 'calendar.html', api: { UURSKTGA5a2hLrai_MXNaoUQ: [] } },
    r => has(r, 'ЛОВИ ДЕНЬ') && r.errs.length === 0],
  ['F16 дата серії за київським часом (опублікована о 00:30 Києва)', { seasons: { seasons: [S1()] }, api: { PL1: [vid('k1', 'Нічна', '2026-09-26T21:30:00Z')] } },
    r => has(r, 'Серія 01 · 27 вересня')],
  ['F17 відео без мініатюри → нема «битої» картинки', { seasons: { seasons: [S1()] }, api: { PL1: [vid('n1', 'Без мініатюри', '2026-09-21T10:00:00Z', '', { noThumb: true })] } },
    async r => await r.page.locator('.ep img[src=""]').count() === 0 && has(r, 'Без мініатюри')],
  ['F18 Ctrl/Cmd-клік відкриває YouTube у новій вкладці (є справжнє посилання)', { seasons: { seasons: [S1()] }, api: { PL1: TWO } },
    async r => /youtu/.test(await r.page.getAttribute('.ep:nth-child(1)', 'href') || '')],

  ['F19 «Нова» не показується, якщо остання серія старша за 7 днів', { seasons: { seasons: [S1()] }, api: { PL1: [vid('o1', 'Стара', '2026-09-20T15:00:00Z')] } },
    async r => await r.page.locator('.ep-new').count() === 0],
  ['F20 справжній seasons.json з репо + реальний стан каналу (публічних відео ще нема): ?check чистий', { path: '?check', api: { 'UURSKTGA5a2hLrai_MXNaoUQ': '404', 'PLS50DDpfd-9w': [] }, shot: 'F20-real-check' },
    r => has(r, 'Помилок не знайдено') && has(r, 'ще нема жодного публічного відео') && has(r, 'Скоро тут зʼявиться перша стрічка')],
  ['F21 клавіатура: Tab до серії, Enter відкриває плеєр, Esc закриває', { seasons: { seasons: [S1()] }, api: { PL1: TWO } },
    async r => { await r.page.focus('.ep'); await r.page.keyboard.press('Enter'); await r.page.waitForTimeout(200);
      let open = await r.page.locator('#vidModal.show').count();
      let onClose = await r.page.evaluate(() => document.activeElement && document.activeElement.classList.contains('close'));
      await r.page.keyboard.press('Escape');
      let back = await r.page.evaluate(() => document.activeElement && document.activeElement.classList.contains('ep'));
      return open === 1 && onClose && back && await r.page.locator('#vidModal.show').count() === 0; }],
  ['F22 повторний візит: спершу кеш, потім свіжі дані з YouTube', { seasons: { seasons: [S1()] }, api: (() => { let n = 0; return pid => (++n === 1 ? TWO : [...TWO, vid('a3', 'Третя', '2026-09-28T15:00:00Z')]); })(),
      reload: async p => { await p.reload(); await p.waitForTimeout(700); } },
    r => has(r, 'Третя') && has(r, '3 серії')],
  ['F23 сезон «Скоро» без плейлиста не вважається помилкою', { path: '?check', seasons: { seasons: [S1(), S1({ n: 2, start: '2027-01-10', end: '', playlist: '' })] }, api: { PL1: TWO } },
    r => has(r, 'Помилок не знайдено')],
  // --- Щоденний формат (підготовка до повернення календаря)
  ['D01 щоденний сезон: стіна днів, сьогодні — пунктир, майбутнього нема', { seasons: { seasons: [S1({ format: 'daily', start: '2026-09-21', end: '2026-10-31', schedule: 'Нове відео щодня' })] },
      api: { PL1: [vid('d1', 'День перший', '2026-09-21T15:00:00Z', 'Записка'), vid('d2', 'День третій', '2026-09-23T15:00:00Z', '№ важливий'), vid('d3', 'Ще того ж дня', '2026-09-23T18:00:00Z')] }, shot: 'D01' },
    async r => has(r, 'День 9 з 41') && has(r, '3 відео') && await r.page.locator('.cell.today').count() === 1
      && await r.page.locator('.cell.has-vid').count() === 2 && await r.page.locator('.v-cont.mult').count() === 1
      && await r.page.locator('.cell .star').count() === 1 && !has(r, '30 ПН')],
  ['D02 щоденний: тиждень з понеділка — роздільник', { seasons: { seasons: [S1({ format: 'daily', start: '2026-09-21', end: '2026-10-31' })] }, api: { PL1: [] } },
    async r => await r.page.locator('.week-divider').count() === 1],
  ['D03 щоденний довгий сезон: відкриті 2 останні місяці, решта в «Раніше»', { seasons: { seasons: [S1({ format: 'daily', start: '2026-05-01', end: '2027-01-31' })] },
      api: { PL1: [vid('m1', 'Травневе', '2026-05-03T10:00:00Z'), vid('m2', 'Серпневе', '2026-08-03T10:00:00Z'), vid('m3', 'Вересневе', '2026-09-03T10:00:00Z')] }, shot: 'D03' },
    async r => await r.page.locator('details.cal-old:not([open])').count() === 1 && has(r, 'Раніше · 3 місяці · 1 відео')
      && await r.page.locator('#app > section > .cal-mo').count() === 2],
  ['D04 щоденний: глибоке посилання на згорнутий місяць розкриває «Раніше»', { path: '#s-1-2026-06', seasons: { seasons: [S1({ format: 'daily', start: '2026-05-01', end: '2027-01-31' })] }, api: { PL1: [] } },
    async r => await r.page.locator('details.cal-old[open]').count() === 1],
  ['D05 щоденний завершений: календар згорнуто, клік по дню відкриває плеєр, день закреслено', { seasons: { seasons: [S1({ format: 'daily', start: '2026-08-01', end: '2026-08-10' })] }, api: { PL1: [vid('e1', 'Серпень', '2026-08-02T10:00:00Z')] } },
    async r => { let closed = await r.page.locator('details.cal-old:not([open])').count(); await r.page.click('details.cal-old summary');
      await r.page.click('.v-lnk'); await r.page.waitForTimeout(150); let open = await r.page.locator('#vidModal.show').count();
      await r.page.keyboard.press('Escape'); return closed === 1 && open === 1 && await r.page.locator('.v-lnk.watched').count() === 1; }],
  ['D06 щоденний у doomsday: дні з archive.json', { state: { mode: 'doomsday' }, seasons: { seasons: [S1({ format: 'daily', start: '2026-09-20', end: '2026-10-31' })] },
      archive: { base: '', days: { '2026-09-22': [{ t: 'Архівний день', p: thumb('#7a5'), y: 'ar' }] } } },
    async r => await r.page.locator('.cell.has-vid').count() === 1 && has(r, 'Архівний день')],
  ['D07 format українською («щоденний») і з опискою', { path: '?check', seasons: { seasons: [S1({ format: 'щоденний' }), S1({ n: 2, format: 'dayly', start: '2026-01-01', end: '2026-02-01', playlist: 'PL2' })] }, api: { PL1: [], PL2: [] } },
    async r => await r.page.locator('#s-1 .grid').count() === 1 && has(r, 'format «dayly» невідомий')],
  ['D08 щоденний на телефоні: 2 колонки, без горизонтального скролу', { seasons: { seasons: [S1({ format: 'daily', start: '2026-09-01', end: '2026-10-31' })] }, api: { PL1: TWO }, viewport: { width: 390, height: 800 }, shot: 'D08-mobile' },
    async r => await r.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length === 2)],
  ['D09 тиждень і щоденний сезони одночасно', { seasons: { seasons: [S1(), S1({ n: 2, format: 'daily', title: 'Щоденник', start: '2026-09-25', end: '2026-10-25', playlist: 'PL2' })] }, api: { PL1: TWO, PL2: [vid('q1', 'Щоденне', '2026-09-26T10:00:00Z')] } },
    async r => await r.page.locator('.eps .ep').count() >= 2 && await r.page.locator('.cell.has-vid').count() === 1],

  // --- Доступність і UX
  ['A01 навігація сезонів — справжні посилання-якорі', { seasons: { seasons: [S1(), S1({ n: 2, start: '2027-01-10', end: '2027-04-04' })] }, api: { PL1: TWO } },
    async r => (await r.page.$$eval('.nav-seg', a => a.map(x => x.tagName + x.getAttribute('href')))).join() === 'A#s-1,A#s-2'],
  ['A02 глибоке посилання #s-0 прокручує до сезону після завантаження', { path: '#s-0', seasons: { seasons: [S1(), S1({ n: 0, title: 'Пілот', start: '2026-07-01', end: '2026-08-31', playlist: 'PL0' })] }, api: { PL1: TWO, PL0: [vid('z1', 'Пілот 1', '2026-07-05T10:00:00Z')] }, wait: 1200 },
    async r => await r.page.evaluate(() => { let top = document.getElementById('s-0').getBoundingClientRect().top, max = document.documentElement.scrollHeight - innerHeight;
      return scrollY > 0 && (Math.abs(top) < 60 || Math.abs(scrollY - max) < 2); })],   // коротка сторінка: доїхали до низу — теж правильно
  ['A03 контраст сірого тексту ≥ 4.5:1', { seasons: { seasons: [S1()] }, api: { PL1: TWO } },
    async r => await r.page.evaluate(() => {
      const lum = c => { let [R, G, B] = c.match(/\d+/g).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * R + .7152 * G + .0722 * B; };
      let fg = lum(getComputedStyle(document.querySelector('.ep-k')).color), bg = lum(getComputedStyle(document.body).backgroundColor);
      return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) >= 4.5; })],
  ['A04 скелет на першому візиті, поки YouTube думає', { seasons: { seasons: [S1()] }, api: { PL1: TWO }, apiDelay: 1500, wait: 500 },
    async r => await r.page.locator('.ep-th.sk').count() === 3 && has(r, 'Тема') && !has(r, '0 серій')],
  ['A05 заголовок h1 — ім\'я автора, сезони — h2', { seasons: { seasons: [S1()] }, api: { PL1: TWO } },
    async r => (await r.page.innerText('h1')).toLowerCase().includes('тарас') && await r.page.locator('h2.s-title').count() === 1],
  ['A06 переглянута серія: смужка + «переглянуто», без хреста', { seasons: { seasons: [S1()] }, api: { PL1: TWO } },
    async r => { await r.page.click('.ep:nth-child(1)'); await r.page.keyboard.press('Escape');
      return await r.page.evaluate(() => { let e = document.querySelector('.ep:nth-child(1)');
        return e.classList.contains('watched') && getComputedStyle(e.querySelector('.ep-k'), '::after').content.includes('переглянуто')
          && getComputedStyle(e.querySelector('.ep-th'), '::before').content === 'none'; }); }],

  // --- Швидкість
  ['P01 запит до YouTube просить лише потрібні поля (fields=)', { seasons: { seasons: [S1()] }, api: { PL1: TWO } },
    r => r.apiUrls.some(u => u.includes('fields='))],
  ['P02 звичайний візит: seasons.json без ?cb (кеш CDN), ?check — з ?cb', { seasons: { seasons: [S1()] }, api: { PL1: TWO } },
    r => r.fileUrls.some(u => /seasons\.json$/.test(u)) && !r.fileUrls.some(u => /cb=/.test(u))],
  ['P03 мініатюри з srcset/sizes; перший ряд — одразу (перша з пріоритетом), решта — ліниво', { seasons: { seasons: [S1()] }, api: { PL1: Array.from({ length: 8 }, (_, i) => vidT('t' + i, 'Серія ' + i, `2026-09-2${i}T10:00:00Z`)) } },
    async r => { let a = await r.page.$$eval('.ep img', im => im.map(x => [!!x.getAttribute('srcset'), x.getAttribute('loading'), x.getAttribute('fetchpriority')]));
      return a.length === 8 && a.every(x => x[0]) && a[0][2] === 'high' && !a[1][2] && !a[1][1] && !a[2][1] && a.slice(3).every(x => x[1] === 'lazy'); }],
  ['P05 телефон: одразу вантажиться лише перша мініатюра', { seasons: { seasons: [S1()] }, viewport: { width: 390, height: 844 }, api: { PL1: Array.from({ length: 4 }, (_, i) => vidT('t' + i, 'Серія ' + i, `2026-09-2${i}T10:00:00Z`)) } },
    async r => { let a = await r.page.$$eval('.ep img', im => im.map(x => x.getAttribute('loading'))); return a[0] === null && a.slice(1).every(x => x === 'lazy'); }],
  ['P04 повторний візит: серії з кешу видно ще до відповіді YouTube', { seasons: { seasons: [S1()] }, api: { PL1: TWO }, apiDelay: 1500,
      reload: async p => { await p.waitForTimeout(1600); await p.reload(); await p.waitForTimeout(300); } },
    async r => await r.page.locator('.ep img').count() === 2],

  // --- Якість мініатюр: не менше ~90% ширини картки в пікселях екрана (регресія «переекономили»)
  ...[['iPhone 13–16, 3x', 390, 3, 'maxres'], ['iPhone SE, 2x', 375, 2, 'standard'], ['ноутбук, 1x', 1280, 1, 'standard'], ['MacBook, 2x', 1440, 2, 'maxres']].map(([d, w, dpr, want]) =>
    [`Q ${d}: велика картка бере ${want}`, { seasons: { seasons: [S1()] }, viewport: { width: w, height: 900 }, dpr, api: { PL1: [vidT('q1', 'Серія', '2026-09-21T10:00:00Z')] } },
      async r => { let src = await r.page.$eval('.ep img', i => i.currentSrc); return src.endsWith('/' + TFILE[want] + '.jpg'); }]),

  // --- Головна: календар першим (з 29.09.2026)
  ['C01 головна — стіна днів: дні від start до сьогодні, сьогодні пунктиром, календар першим', { seasons: CAL({ start: '2026-09-20' }), api: { UU1: [vid('c1', 'Перше', '2026-09-21T10:00:00Z')], SH: [] }, shot: 'C01' },
    async r => await r.page.locator('#cal .cell.has-vid').count() === 1 && await r.page.locator('#cal .cell.today').count() === 1
      && (await r.page.$eval('#app', a => a.firstElementChild.id)) === 'cal' && !has(r, 'перший сезон')],
  ['C02 до першого дня — спокійна заглушка без відліку', { seasons: CAL({ start: '2026-10-05' }), api: { UU1: [], SH: [] } },
    async r => has(r, 'Скоро тут зʼявиться перша стрічка') && await r.page.locator('#cal .grid').count() === 0],
  ['C03 Shorts (плейлист-виняток) у календар не потрапляють', { seasons: CAL({ start: '2026-09-20' }), api: { UU1: [vid('c1', 'Відео', '2026-09-21T10:00:00Z'), vid('s1', 'Шортс', '2026-09-22T10:00:00Z')], SH: [vid('s1', 'Шортс', '2026-09-22T10:00:00Z')] } },
    r => has(r, 'Відео') && !has(r, 'Шортс')],
  ['C04 завантаження ще недоступні (0 публічних відео) — не помилка', { path: '?check', seasons: CAL({ start: '2026-09-20' }), api: { UU1: '404', SH: [] } },
    r => has(r, 'Помилок не знайдено') && has(r, 'ще нема жодного публічного відео')],
  ['C05 відео до start (проби) на стіну не потрапляють', { seasons: CAL({ start: '2026-09-20' }), api: { UU1: [vid('p0', 'Проба', '2026-09-10T10:00:00Z'), vid('c1', 'Справжнє', '2026-09-21T10:00:00Z')], SH: [] } },
    r => has(r, 'Справжнє') && !has(r, 'Проба')],
  ['C06 календар + сезони: календар вище за сезони', { seasons: Object.assign(CAL({ start: '2026-09-20' }), { seasons: [S1({ playlist: 'PL1' })] }), api: { UU1: [], SH: [], PL1: TWO } },
    async r => await r.page.evaluate(() => document.getElementById('cal').compareDocumentPosition(document.getElementById('s-1')) & Node.DOCUMENT_POSITION_FOLLOWING)],
  ['C07 телефон: 12 тем в один рядок, календар на першому екрані', { seasons: CAL({ start: '2026-09-20' }), viewport: { width: 390, height: 844 },
      api: { UU1: Array.from({ length: 12 }, (_, i) => vid('t' + i, 'Відео ' + i, `2026-09-2${i % 9 + 1}T1${i % 10}:00:00Z`, '#тема' + i + ' #спільна')), SH: [] }, shot: 'C07-mobile' },
    async r => await r.page.evaluate(() => document.getElementById('cal').getBoundingClientRect().top < 400 && document.documentElement.scrollWidth <= innerWidth)],

  // --- Каталог тем з хештегів
  ['T01 теми з хештегів (опис + назва), лічильники, без чисел/якорів/#shorts', { seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] }, shot: 'T01' },
    async r => { let c = await r.page.$$eval('.topics .chip', a => a.map(x => x.textContent));
      return c.join('|') === '#подорожі3|#книги1'; }],   // рівно дві теми: без #1, #top із посилання та #shorts
  ['T02 клік по темі: адреса #t=…, панель з відео (найновіші першими), календар приглушує інші', { seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] }, shot: 'T02' },
    async r => { await r.page.click('.topics .chip >> nth=0'); await r.page.waitForTimeout(200);
      let titles = await r.page.$$eval('#topic .ep-t', a => a.map(x => x.textContent));
      return decodeURIComponent(await r.page.evaluate(() => location.hash)) === '#t=подорожі' && titles.join('|') === 'Третє|Друге|Перше'
        && await r.page.locator('#cal.filtering .v-lnk.hit').count() === 3 && await r.page.locator('#cal .v-lnk:not(.hit)').count() === 1; }],
  ['T03 topics у seasons.json: синоніми, назва, опис; ignore_tags', { seasons: Object.assign(CAL({ start: '2026-09-20' }), { topics: [{ tag: 'подорожі', title: 'Подорожі', about: 'Про дороги.', aliases: ['#подорож'] }], ignore_tags: ['книги'] }),
      api: { UU1: [...TAGGED, vid('e1', 'Синонім', '2026-09-26T10:00:00Z', '#подорож')], SH: [] }, path: '#t=подорожі' },
    async r => { let c = await r.page.$$eval('.topics .chip', a => a.map(x => x.textContent)); return c.join('|') === 'Подорожі4' && has(r, 'Про дороги.'); }],
  ['T04 глибоке посилання #t=… відкриває тему одразу', { path: '#t=' + encodeURIComponent('книги'), seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    async r => (await r.page.innerText('#topic h2')) === '#книги'],
  ['T05 плеєр: теми відео чипами, клік — закриває плеєр і відкриває тему', { seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    async r => { await r.page.click('#cal .v-lnk >> nth=0'); await r.page.waitForTimeout(150);
      let chips = await r.page.$$eval('.note-tags .chip', a => a.map(x => x.textContent));
      await r.page.click('.note-tags .chip >> text=#книги'); await r.page.waitForTimeout(200);
      return chips.join('|') === '#подорожі|#книги' && await r.page.locator('#vidModal.show').count() === 0 && (await r.page.innerText('#topic h2')) === '#книги'; }],
  ['T06 «× Усі дні» знімає вибір', { path: '#t=' + encodeURIComponent('книги'), seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    async r => { await r.page.click('#topic a[href="#"]'); await r.page.waitForTimeout(150);
      return await r.page.locator('#topic').count() === 0 && await r.page.locator('#cal.filtering').count() === 0; }],
  ['T07 невідома тема — «поки що нема відео»', { path: '#t=' + encodeURIComponent('немає'), seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    r => has(r, 'Поки що нема відео з цією темою')],
  ['T08 doomsday: теми з описів у archive.json', { state: { mode: 'doomsday' }, seasons: CAL({ start: '2026-09-20' }),
      archive: { base: '', days: { '2026-09-22': [{ t: 'Архів', y: 'ar', desc: 'Текст #архів' }] } } },
    async r => (await r.page.$$eval('.topics .chip', a => a.map(x => x.textContent))).join() === '#архів1'],
  ['T09 ?check показує теми з кількістю', { path: '?check', seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    r => has(r, '#подорожі (3), #книги (1)')],
  ['H30 помилки в новому блоці: calendar без playlist, topics не список, описка в полі', { path: '?check', seasons: { calendar: { start: '2026-09-20' }, topics: 'подорожі', seasns: [] } },
    r => has(r, 'calendar: нема playlist') && has(r, 'topics: очікую список') && has(r, 'невідоме поле «seasns»')],

  // --- Переглянуте: зберігається між візитами
  ['W01 переглянуте лишається після закриття браузера (новий сеанс із тим самим сховищем)', { seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    async r => { await r.page.click('#cal .v-lnk >> nth=1'); await r.page.keyboard.press('Escape');
      const state = await r.ctx.storageState();
      const { r: r2, ctx } = await scenario(r.browser, Object.assign({}, r.o, { storageState: state }));
      const ok = await r2.page.locator('#cal .v-lnk.watched').count() === 1 && (await r2.page.getAttribute('#cal .v-lnk.watched', 'data-k')) === 'g2';
      await ctx.close(); return ok; }],
  ['W02 відмітка одразу на всіх копіях відео (календар + панель теми)', { path: '#t=' + encodeURIComponent('подорожі'), seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    async r => { await r.page.click('#topic .ep >> nth=0'); await r.page.keyboard.press('Escape');
      return await r.page.locator('[data-k="g3"].watched').count() === 2; }],
  ['W03 відмітка в одній вкладці зʼявляється в іншій без перезавантаження', { seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    async r => { const p2 = await r.ctx.newPage(); await p2.goto(r.page.url()); await p2.waitForTimeout(600);
      await r.page.click('#cal .v-lnk >> nth=0'); await r.page.keyboard.press('Escape'); await p2.waitForTimeout(300);
      return await p2.locator('#cal .v-lnk.watched').count() === 1; }],
  ['W04 той самий ключ відмітки в режимах youtube і doomsday', { seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] },
      initScript: () => { try { localStorage.setItem('vw', JSON.stringify(['g1'])); } catch (e) {} },
      state: { mode: 'doomsday' }, archive: { base: '', days: { '2026-09-21': [{ t: 'Перше', y: 'g1' }] } } },
    async r => await r.page.locator('#cal .v-lnk.watched').count() === 1],

  // --- Відкриття: компʼютер — вікно на сайті; телефон — застосунок YouTube
  ['M01 компʼютер: вікно з плеєром на сайті, без переходу', { seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    async r => { await r.page.click('#cal .v-lnk >> nth=0'); await r.page.waitForTimeout(150);
      return await r.page.locator('#vidModal.show').count() === 1 && r.page.url().startsWith('http://localhost'); }],
  ['M02 iPhone: перехід на youtube.com/watch (відкриє застосунок YouTube), без вікна, відмічено', { ua: UA_IPHONE, mobile: true, viewport: { width: 390, height: 844 }, seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    async r => { await Promise.all([r.page.waitForURL(/youtube\.com\/watch\?v=g1/), r.page.tap('#cal .v-lnk >> nth=0')]);
      await r.page.goBack(); await r.page.waitForTimeout(500);
      return await r.page.locator('#cal .v-lnk.watched').count() === 1; }],
  ['M03 Android: intent у застосунок YouTube із запасним переходом на сайт', { ua: UA_ANDROID, mobile: true, viewport: { width: 412, height: 915 }, seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    async r => { await r.page.tap('#cal .v-lnk >> nth=0'); await r.page.waitForTimeout(150);
      const u = await r.page.evaluate(() => window.__opened || '');
      return u.startsWith('intent://www.youtube.com/watch?v=g1#Intent;') && u.includes('package=com.google.android.youtube') && u.includes('S.browser_fallback_url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dg1')
        && await r.page.locator('#vidModal.show').count() === 0 && await r.page.locator('#cal .v-lnk.watched').count() === 1; }],
  ['M04 iPad (iPadOS видає себе за Mac) — теж застосунок', { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', mobile: false, viewport: { width: 820, height: 1180 },
      initScript: () => { Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }); Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }); },
      seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    async r => { await Promise.all([r.page.waitForURL(/youtube\.com\/watch/), r.page.click('#cal .v-lnk >> nth=0')]); return true; }],
  ['M05 телефон + локальне відео (doomsday, без YouTube) — вікно на сайті', { ua: UA_IPHONE, mobile: true, viewport: { width: 390, height: 844 }, state: { mode: 'doomsday' }, seasons: CAL({ start: '2026-09-20' }),
      archive: { base: 'https://video.example', days: { '2026-09-22': [{ t: 'Локальне', y: 'yy', v: 'a.mp4' }] } } },
    async r => { await r.page.tap('#cal .v-lnk'); await r.page.waitForTimeout(150); return await r.page.locator('#vidModal.show').count() === 1; }],
  ['M06 Ctrl/Cmd-клік на компʼютері — нова вкладка, відмітка не ставиться', { seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    async r => { const [p2] = await Promise.all([r.ctx.waitForEvent('page'), r.page.click('#cal .v-lnk >> nth=0', { modifiers: ['ControlOrMeta'] })]);
      await p2.close(); return await r.page.locator('#vidModal.show').count() === 0; }],

  // --- Швидкість, коли відео багато
  ['P06 перший візит, 120 відео (3 сторінки): перші 50 видно вже після першої сторінки', { seasons: CAL({ start: '2026-05-01' }), api: pagedApi(DAILY120, { SH: [] }), apiDelay: 400, wait: 650 },
    async r => { let first = await r.page.locator('#cal .v-lnk').count(); await r.page.waitForTimeout(1300);
      return first === 50 && await r.page.locator('#cal .v-lnk').count() === 120; }],
  ['P07 повторний візит (кеш < доби): лише 1 запит до списку завантажень, старіші — з кешу', { seasons: CAL({ start: '2026-05-01' }), api: pagedApi(DAILY120, { SH: [] }), initScript: cacheInit(3600e3) },
    async r => r.apiUrls.filter(u => u.includes('UU1')).length === 1 && await r.page.locator('#cal .v-lnk').count() === 120],
  ['P08 кеш старший за добу — повний перезбір усіх сторінок', { seasons: CAL({ start: '2026-05-01' }), api: pagedApi(DAILY120, { SH: [] }), initScript: cacheInit(2 * 864e5), wait: 1200 },
    async r => r.apiUrls.filter(u => u.includes('UU1')).length === 3 && await r.page.locator('#cal .v-lnk').count() === 120],

  // --- UX
  ['U01 назви на плитках — без хвоста з хештегів', { seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] } },
    async r => (await r.page.$$eval('#cal .v-title', a => a.map(x => x.textContent))).includes('Друге')],
  ['U02 чипи тем: зона дотику ≥ 40 px на телефоні', { seasons: CAL({ start: '2026-09-20' }), api: { UU1: TAGGED, SH: [] }, viewport: { width: 390, height: 844 } },
    async r => (await r.page.$eval('.chip', c => c.getBoundingClientRect().height)) >= 40],

  ['U03 телефон: «Сьогодні ↓» веде до сьогоднішнього дня, не чіпаючи вибрану тему; на компʼютері кнопки нема', { path: '#t=' + encodeURIComponent('подорожі'), seasons: CAL({ start: '2026-09-01' }), api: { UU1: DAILY120.slice(0, 28), SH: [] }, viewport: { width: 390, height: 700 } },
    async r => { await r.page.click('.to-today'); await r.page.waitForTimeout(900);
      let inView = await r.page.evaluate(() => { let b = document.getElementById('cal-today').getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; });
      await r.page.setViewportSize({ width: 1280, height: 900 });
      let hiddenDesk = await r.page.$eval('.to-today', a => getComputedStyle(a).display === 'none');
      return inView && hiddenDesk && decodeURIComponent(await r.page.evaluate(() => location.hash)) === '#t=подорожі'; }],
  ['U04 багато тем: на компʼютері 12 + «ще N», на телефоні всі в рядку', { seasons: CAL({ start: '2026-09-01' }),
      api: { UU1: Array.from({ length: 20 }, (_, i) => vid('x' + i, 'Відео', `2026-09-${String(i + 2).padStart(2, '0')}T10:00:00Z`, '#тема' + i)), SH: [] } },
    async r => { const vis = () => r.page.$$eval('.topics .chip:not(.more)', a => a.filter(x => getComputedStyle(x).display !== 'none').length);
      let d1 = await vis(); await r.page.click('.chip.more'); let d2 = await vis();
      await r.page.setViewportSize({ width: 390, height: 800 }); await r.page.evaluate(() => { LAST_HTML = ''; render(); });
      let m = await vis(), moreHidden = await r.page.$eval('.chip.more', b => getComputedStyle(b).display === 'none');
      return d1 === 12 && d2 === 20 && m === 20 && moreHidden; }],

  // --- Людські помилки в новому блоці календаря й тем
  ['H31 calendar.start у форматі 20.09.2026', { path: '?check', seasons: { calendar: { start: '20.09.2026', playlist: 'UU1', exclude: ['SH'] } }, api: { UU1: TAGGED, SH: [] } },
    async r => has(r, 'прочитано як 2026-09-20') && await r.page.locator('#cal .v-lnk').count() === 4],
  ['H32 замість плейлиста — ID каналу (UC…) → беремо його завантаження (UU…)', { path: '?check', seasons: { calendar: { start: '2026-09-20', playlist: 'UC' + 'RSKTGA5a2hLrai_MXNaoUQ' } }, api: { UURSKTGA5a2hLrai_MXNaoUQ: TAGGED } },
    async r => has(r, 'це канал, а не плейлист') && await r.page.locator('#cal .v-lnk').count() === 4],
  ['H33 посилання на канал з /channel/UC…', { seasons: { calendar: { start: '2026-09-20', playlist: 'https://www.youtube.com/channel/UCRSKTGA5a2hLrai_MXNaoUQ' } }, api: { UURSKTGA5a2hLrai_MXNaoUQ: TAGGED } },
    async r => await r.page.locator('#cal .v-lnk').count() === 4],
  ['H34 @назва каналу замість плейлиста → зрозуміле пояснення', { path: '?check', seasons: { calendar: { start: '2026-09-20', playlist: 'https://www.youtube.com/@Taras.maksymiak' } } },
    r => has(r, 'це назва каналу; потрібен ID плейлиста')],
  ['H35 повне посилання на плейлист у calendar.playlist', { seasons: { calendar: { start: '2026-09-20', playlist: 'https://www.youtube.com/playlist?list=UU1' } }, api: { UU1: TAGGED } },
    async r => await r.page.locator('#cal .v-lnk').count() === 4],
  ['H36 exclude рядком, а не списком', { seasons: { calendar: { start: '2026-09-20', playlist: 'UU1', exclude: 'SH' } }, api: { UU1: [...TAGGED, vid('s1', 'Шортс', '2026-09-25T10:00:00Z')], SH: [vid('s1', 'Шортс', '2026-09-25T10:00:00Z')] } },
    r => !has(r, 'Шортс')],
  ['H37 теми в topics з # і великими літерами; описка-варіант видно в ?check', { path: '?check', seasons: Object.assign(CAL({ start: '2026-09-20' }), { topics: [{ tag: '#ПОДОРОЖІ', title: 'Подорожі' }] }),
      api: { UU1: [...TAGGED, vid('y1', 'Описка', '2026-09-25T10:00:00Z', '#подорожи')], SH: [] } },
    r => has(r, 'Подорожі (3)') && has(r, '#подорожи (1)')],
  ['H38 старт календаря в майбутньому (описка в році) — ?check пояснює заглушку', { path: '?check', seasons: CAL({ start: '2027-09-30' }), api: { UU1: TAGGED, SH: [] } },
    r => has(r, 'ще не почався') && has(r, 'Скоро тут зʼявиться перша стрічка')],

  // --- Людські помилки в seasons.json
  ['H01 зайва кома після останнього поля', { seasons: '{"seasons":[{"n":1,"title":"Тема","start":"2026-09-20","end":"2026-12-20","playlist":"PL1",}],}', api: { PL1: TWO } },
    r => has(r, 'Тема') && has(r, '2 серії')],
  ['H02 номер сезону рядком "1"', { seasons: { seasons: [S1({ n: '1' })] }, api: { PL1: TWO } }, r => has(r, 'Тема') && has(r, 'Сезон 1')],
  ['H03 дата у форматі 20.09.2026', { seasons: { seasons: [S1({ start: '20.09.2026', end: '20.12.2026' })] }, api: { PL1: TWO } },
    r => has(r, '20 вересня — 20 грудня 2026') && has(r, 'Тиждень 2 з 13')],
  ['H04 дата без нулів 2026-9-20', { seasons: { seasons: [S1({ start: '2026-9-20' })] }, api: { PL1: TWO } }, r => has(r, '20 вересня — 20 грудня 2026')],
  ['H05 end раніше за start (описка в році)', { seasons: { seasons: [S1({ end: '2025-12-20' })] }, api: { PL1: TWO } },
    r => has(r, 'Тема') && has(r, 'Зараз') && has(r, '2 серії')],
  ['H06 плейлист вставлено повним посиланням', { seasons: { seasons: [S1({ playlist: 'https://www.youtube.com/playlist?list=PL1&si=abc' })] }, api: { PL1: TWO } },
    r => has(r, '2 серії') && r.apiCalls.includes('PL1')],
  ['H07 плейлист з пробілами навколо', { seasons: { seasons: [S1({ playlist: '  PL1 ' })] }, api: { PL1: TWO } }, r => has(r, '2 серії')],
  ['H08 описка в ID плейлиста одного сезону не ламає інший', { seasons: { seasons: [S1({ n: 0, title: 'Пілот', start: '2026-07-01', end: '2026-08-31', playlist: 'PLtypo' }), S1()] },
      api: { PL1: TWO, PLtypo: '404' } },
    r => has(r, '2 серії') && has(r, 'Пілот')],
  ['H09 два сезони з однаковим n', { seasons: { seasons: [S1({ title: 'Перша тема', start: '2026-07-01', end: '2026-08-31', playlist: 'PL0' }), S1()] }, api: { PL0: [vid('z1', 'Пілот 1', '2026-07-05T10:00:00Z')], PL1: TWO } },
    async r => has(r, 'Перша тема') && has(r, 'Пілот 1') && has(r, 'Друга') && new Set(await r.page.$$eval('section.season', s => s.map(x => x.id))).size === 2],
  ['H10 файл — просто масив без {"seasons": …}', { seasons: [S1()], api: { PL1: TWO } }, r => has(r, 'Тема') && has(r, '2 серії')],
  ['H11 support без https://', { seasons: { seasons: [S1({ support: 'send.monobank.ua/jar/ABC' })] }, api: { PL1: TWO } },
    async r => (await r.page.getAttribute('a.hot', 'href')) === 'https://send.monobank.ua/jar/ABC'],
  ['H12 support з javascript: не стає посиланням', { seasons: { seasons: [S1({ support: 'javascript:alert(1)' })] }, api: { PL1: TWO } },
    async r => await r.page.locator('a[href^="javascript"]').count() === 0],
  ['H13 episodes рядком "10"', { seasons: { seasons: [S1({ episodes: '10' })] }, api: { PL1: TWO } }, r => has(r, 'Серій: 2 / 10')],
  ['H14 порожній список сезонів → спокійне повідомлення', { seasons: { seasons: [] } }, r => has(r, 'Скоро тут зʼявиться перший сезон')],
  ['H15 seasons.json зник (404) → повідомлення, не біла сторінка', { seasons: 404 }, r => has(r, 'Не вдалось завантажити')],
  ['H16 HTML у назві екранується', { seasons: { seasons: [S1({ title: '<img src=x onerror=alert(1)>Тема' })] }, api: { PL1: TWO } },
    async r => has(r, '<img src=x') && await r.page.locator('h2 img').count() === 0],
  ['H17 неіснуюча дата 2026-02-30 у end → end ігнорується', { seasons: { seasons: [S1({ end: '2026-02-30' })] }, api: { PL1: TWO } },
    r => has(r, 'Тема') && has(r, '2 серії') && !has(r, 'NaN') && !has(r, 'undefined')],
  ['H18 забув start → сезон усе одно видно', { seasons: { seasons: [S1({ start: undefined })] }, api: { PL1: TWO } },
    r => has(r, 'Тема') && has(r, '2 серії') && !has(r, 'NaN') && !has(r, 'undefined')],
  ['H19 localStorage заблоковано (приватний режим) → сторінка працює', { seasons: { seasons: [S1()] }, api: { PL1: TWO },
      initScript: () => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError'); } }); } },
    r => has(r, '2 серії') && r.errs.length === 0],
  ['H20 зіпсований запис у localStorage (vw) → сторінка працює', { seasons: { seasons: [S1()] }, api: { PL1: TWO },
      initScript: () => { try { localStorage.setItem('vw', '{oops'); } catch (e) {} } },
    r => has(r, '2 серії') && r.errs.length === 0],
  ['H21 state.json з опискою/битий → режим youtube', { seasons: { seasons: [S1()] }, api: { PL1: TWO }, state: '{"mode": "doomday",' }, r => has(r, '2 серії')],
  ['H22 BOM на початку файлу (Блокнот Windows)', { seasons: '﻿' + JSON.stringify({ seasons: [S1()] }), api: { PL1: TWO } }, r => has(r, '2 серії')],
  ['H23 описка в назві поля («tittle») → попередження в консолі', { seasons: { seasons: [Object.assign(S1({ title: '' }), { tittle: 'Тема' })] }, api: { PL1: TWO } },
    r => r.warns.some(w => w.includes('tittle'))],
  ['H24 безнадійно битий JSON → остання справна версія з кешу', { seasons: '{"seasons": [ {"n": 1, "title": "Тема" "start": }', api: { PL1: TWO },
      initScript: () => { try { localStorage.setItem('ss_seasons', JSON.stringify({ seasons: [{ n: 1, title: 'Кешована тема', start: '2026-09-20', end: '2026-12-20', playlist: 'PL1' }] })); } catch (e) {} } },
    r => has(r, 'Кешована тема')],
  ['H25 сторінка перевірки ?check показує проблеми і приховані відео', { path: '?check', seasons: { seasons: [S1({ start: '20.09.2026', playlist: '' }), S1({ n: 2, start: '2027-01-10', end: '2027-04-04' })] }, api: { PL1: [priv('x1'), ...TWO] }, shot: 'H25-check' },
    r => has(r, 'нема плейлиста') && has(r, 'ще 1 приховано') && has(r, 'прочитано як 2026-09-20')],
  ['H26 битий JSON без кешу + ?check → видно, в якому рядку помилка', { path: '?check', seasons: '{\n "seasons": [\n  {"n": 1 "title": "Тема"}\n ]\n}' },
    r => has(r, 'Не вдалось завантажити') && has(r, 'рядок 3')],
  ['H27 назва сезону з лапками/апострофом/емодзі', { seasons: { seasons: [S1({ title: 'Тарас\'ова «тема» "1" 🌓', about: 'Рядок 1\nРядок 2' })] }, api: { PL1: TWO } },
    async r => (await r.page.innerText('h2')).includes('«тема» "1" 🌓') && (await r.page.innerText('.s-about')).includes('Рядок 1\nРядок 2')],
  ['H28 зіпсований кеш серій у браузері → сторінка працює, дані з YouTube', { seasons: { seasons: [S1()] }, api: { PL1: TWO },
      initScript: () => { try { localStorage.setItem('ss_pl', JSON.stringify({ PL1: 'сміття', PL2: [{ key: 1 }] })); localStorage.setItem('ss_time', String(Date.now())); } catch (e) {} } },
    r => has(r, '2 серії') && r.errs.length === 0],
  ['H29 archive.json з кривою датою-ключем → пропускається', { state: { mode: 'doomsday' }, seasons: { seasons: [S1()] },
      archive: { base: '', days: { '2026-9-21': [{ t: 'Крива дата', y: 'q' }], '2026-09-22': 'не масив', '2026-09-23': [{ t: 'Нормальна', y: 'w' }] } } },
    r => has(r, 'Нормальна') && !has(r, 'Крива дата') && !has(r, 'NaN')],
];

(async () => {
  const browser = await chromium.launch(EXE);
  let pass = 0, fail = 0;
  for (const [name, o, check] of CASES) {
    if (ONLY && !ONLY.test(name)) continue;
    let ok = false, note = '';
    try {
      const { r, ctx } = await scenario(browser, o);
      ok = await check(r);
      if (r.errs.length) { ok = false; note = ' JS: ' + r.errs.join('; '); }
      if (!ok && !note) note = ' → ' + r.text.slice(0, 260);
      await ctx.close();
    } catch (e) { note = ' EXC: ' + e.message.split('\n')[0]; }
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : note}`);
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  await browser.close(); server.close();
})();
