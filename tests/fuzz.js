// Фаз-тест: сміття на вході — сайт і бот не падають. Відтворюваний (seed).
//   node tests/fuzz.js [seed] [ітерацій сайту] [ітерацій бота]     напр.: node tests/fuzz.js 7 150 500
// Сайт: випадкові seasons.json (зокрема зламані), відповіді YouTube, fundraisers.json, адреси (#…), екрани.
//   Інваріанти: нема JS-помилок і alert, нема вставлених onerror/onload, нема javascript:-посилань,
//   сторінка щось показала, нема горизонтального скролу; клік по відео відкриває плеєр без помилок.
// Бот (tools/zbir.mjs): випадкові команди підряд в одній копії репо.
//   Інваріанти: вихід 0/1 з відповіддю ✅/❌ (не стек помилки), seasons.json — завжди коректний JSON,
//   у кожного збору — латинський якір, посилання на банку, ціль-число, дата РРРР-ММ-ДД або порожньо.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const EXE = fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
const ROOT = path.resolve(__dirname, '..');
const SEED = +(process.argv[2] || 1), N_SITE = +(process.argv[3] || 80), N_BOT = +(process.argv[4] || 300);

// Відтворюваний генератор (mulberry32)
let st = SEED >>> 0;
const rnd = () => { st = (st + 0x6D2B79F5) >>> 0; let t = st; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)], chance = p => rnd() < p, int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const NASTY = ['<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', "');alert(1);//", 'javascript:alert(1)', '%E0%A4%A', '__proto__',
  'constructor', '‮текст', '🌓'.repeat(30), 'ж'.repeat(3000), '', ' ', null, 0, -1, 1e21, true, [], {}, '2026-02-30', '31.12.2026',
  '2026-9-1', 'NaN', 'Дрон для бригади', '#подорожі', 'UU1', 'SH', 'send.monobank.ua/jar/AbC123xyz', 'https://send.monobank.ua/jar/XXXXXXXXXX'];
const nasty = () => pick(NASTY);
const day = () => `2026-${String(int(8, 10)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
const maybe = (v, p = 0.5) => chance(p) ? v : undefined;

function fund() {
  return chance(0.15) ? nasty() : { enabled: pick([true, false, 'так', nasty()]), id: maybe(pick(['dron', nasty()])), title: pick(['Дрон', nasty()]),
    about: maybe(nasty()), url: pick(['https://send.monobank.ua/jar/AbC123xyz', 'send.monobank.ua/jar/Q1w2e3r4', nasty()]),
    goal: pick([50000, '50 000 грн', '50к', 0, nasty()]), raised: pick([18500, '1 500,50', nasty()]), until: maybe(pick([day(), '2027-01-01', nasty()])),
    kind: maybe(pick(['charity', 'channel', 'благодійний', nasty()])), [pick(['tittle', 'x'])]: maybe(1, 0.1) };
}
function config() {
  if (chance(0.05)) return '{"calendar": {"start": ' + nasty();             // зламаний JSON
  if (chance(0.05)) return [{ n: pick([1, '1', nasty()]), title: nasty(), playlist: 'PL1', start: pick([day(), nasty()]) }];
  let c = {};
  if (chance(0.9)) c.calendar = chance(0.1) ? nasty() : { start: pick([day(), '2026-08-01', nasty()]), playlist: pick(['UU1', 'UU1', 'UCabcdefghijklmnopqrstuv', nasty()]),
    exclude: pick([['SH'], 'SH', nasty()]), enabled: maybe(pick([true, false, 'ні', 'так', nasty()]), 0.3) };
  if (chance(0.5)) c.topics = chance(0.2) ? nasty() : [{ tag: pick(['подорожі', nasty()]), title: maybe(nasty()), about: maybe(nasty()), aliases: maybe(pick([['мандри'], nasty()])) }];
  if (chance(0.3)) c.ignore_tags = pick([['shorts'], nasty()]);
  if (chance(0.3)) c.seasons = chance(0.2) ? nasty() : [{ n: pick([1, '2', nasty()]), format: pick(['weekly', 'daily', nasty()]), title: nasty(), about: maybe(nasty()),
    start: pick([day(), nasty()]), end: maybe(pick([day(), nasty()])), playlist: pick(['PL1', nasty()]), episodes: maybe(pick([10, '10', nasty()])), support: maybe(nasty()) }];
  if (chance(0.7)) c.support = chance(0.1) ? nasty() : { enabled: pick([true, true, false, nasty()]), donate: maybe(pick([{ enabled: true, url: pick(['https://send.monobank.ua/jar/Don0001', nasty()]) }, nasty()])),
    fundraisers: chance(0.15) ? fund() : Array.from({ length: int(0, 3) }, fund) };
  if (chance(0.1)) c[nasty() || 'x'] = nasty();
  return c;
}
function item(i) {
  let pub = pick([new Date(Date.UTC(2026, 8, int(1, 29), int(0, 23))).toISOString(), new Date(Date.UTC(2026, 8, int(1, 29))).toISOString(), nasty(), undefined]);
  let title = pick(['День ' + i, nasty(), `Відео #${pick(['подорожі', 'книги', String(nasty())])}`]);
  return { snippet: chance(0.05) ? undefined : { title, description: pick(['', nasty(), `${nasty()} #подорожі #${nasty()}\n\n🕒 18:00 27/09/2026`, '№ Важливе']),
      resourceId: { videoId: pick(['v' + i, nasty()]) }, thumbnails: pick([{}, { maxres: { url: 'https://i.ytimg.com/vi/v/maxresdefault.jpg', width: 1280, height: 720 } }, { high: { url: nasty() } }]) },
    contentDetails: { videoId: 'v' + i, videoPublishedAt: pub }, status: { privacyStatus: pick(['public', 'public', 'unlisted', 'private', nasty()]) } };
}

// ── Сайт ──
const server = http.createServer((req, res) => {
  let p; try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/') p = '/index.html';
  let f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': { '.json': 'application/json', '.js': 'text/javascript' }[path.extname(f)] || 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(f));
}).listen(8767);

async function siteRun(browser, i) {
  const cfg = config(), items = Array.from({ length: int(0, 40) }, (_, k) => item(k));
  const mobile = chance(0.3), vw = mobile ? pick([320, 375]) : pick([768, 1280]);
  const ctx = await browser.newContext({ viewport: { width: vw, height: 800 }, serviceWorkers: 'block', colorScheme: pick(['light', 'dark']),
    userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36' : undefined, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage(), problems = [];
  await page.clock.setFixedTime(new Date('2026-09-29T15:00:00+03:00'));
  page.on('pageerror', e => problems.push('JS: ' + e.message));
  page.on('dialog', d => { problems.push('ALERT: ' + d.message()); d.dismiss().catch(() => {}); });
  await page.addInitScript(() => { window.openApp = u => { window.__opened = u; }; });
  // Сміття й справжні значення в памʼяті браузера: минулий візит, «мій день», переглянуте; «Поділитися» — заглушка
  const lv = pick(['', '{oops', '[1]', 'null', JSON.stringify({ prev: 0, cur: Date.parse('2026-09-25T10:00:00Z') }), JSON.stringify({ prev: 'x', cur: 9e15 })]);
  const md = pick(['', '09-23', '02-29', '99-99', 'abc', '04-31']), seen = pick(['', '["v1","v2"]', '{bad', '[1,null,"v3"]']);
  await page.addInitScript(([lv, md, seen]) => { try { if (lv) localStorage.setItem('lv', lv); if (md) localStorage.setItem('md', md); if (seen) localStorage.setItem('vw', seen); } catch (e) {}
    navigator.canShare = () => true; navigator.share = async () => {}; }, [lv, md, seen]);
  await ctx.route(/googleapis\.com/, r => {
    const pid = new URL(r.request().url()).searchParams.get('playlistId');
    if (pid === 'UU1' || pid === 'PL1') return chance(0.1) ? r.fulfill({ status: pick([403, 404, 500]), body: '{}' }) : r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items }) });
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: chance(0.5) ? items.slice(0, 2) : [] }) });
  });
  await ctx.route(/i\.ytimg\.com/, r => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"/>' }));
  await ctx.route(/youtube\.com\/(embed|watch)/, r => r.fulfill({ contentType: 'text/html', body: '' }));
  await ctx.route(/seasons\.json/, r => r.fulfill({ contentType: 'application/json', body: typeof cfg === 'string' ? cfg : JSON.stringify(cfg) }));
  await ctx.route(/fundraisers\.json/, r => chance(0.3) ? r.fulfill({ status: 404 }) : r.fulfill({ contentType: 'application/json',
    body: pick([JSON.stringify({ jars: { AbC123xyz: { raised: pick([41000, -5, 'x', 1e12]), goal: pick([60000, 0, nasty()]) } } }), '{"jars":', JSON.stringify(nasty())]) }));
  await ctx.route(/state\.json/, r => r.fulfill({ contentType: 'application/json', body: pick(['{"mode":"youtube"}', '{"mode":"doomsday"}', '{', '']) }));
  await ctx.route(/archive\.json/, r => r.fulfill({ contentType: 'application/json', body: pick(['{"base":"","days":{}}', JSON.stringify({ days: { [day()]: [{ t: nasty(), y: 'a1', d: nasty() }], [String(nasty())]: nasty() } }), '{']) }));
  const hash = pick(['', '', '#t=' + encodeURIComponent(String(nasty())), '#t=%E0%A4%A', '#d=' + day(), '#f-dron', '#%', '#cal-2026-09-21', '#d=' + String(nasty())]);
  const url = 'http://localhost:8767/' + pick(['', '', '?check']) + hash;
  try {
    await page.goto(url); await page.waitForTimeout(500);
    const chk = await page.evaluate(() => ({
      injected: document.querySelectorAll('[onerror],[onload]').length,
      jsLinks: [...document.querySelectorAll('a[href]')].filter(a => /^\s*javascript:/i.test(a.getAttribute('href'))).length,
      app: (document.getElementById('app') || {}).innerHTML.length,
      hscroll: document.documentElement.scrollWidth > innerWidth + 1,
      wide: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.topics,.modal')).slice(0, 2).map(e => e.tagName + '.' + e.className),
    }));
    if (chk.injected) problems.push(`вставлено ${chk.injected} елементів з onerror/onload`);
    if (chk.jsLinks) problems.push(`javascript:-посилань: ${chk.jsLinks}`);
    if (!chk.app) problems.push('порожня сторінка');
    if (chk.hscroll) problems.push('горизонтальний скрол: ' + chk.wide.join(', '));
    const v = page.locator('#cal .v-lnk, .ep').first();
    if (!mobile && await v.count()) {
      await v.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(150);
      for (let k = int(0, 4); k > 0; k--) await page.keyboard.press(pick(['ArrowLeft', 'ArrowRight']));   // гортати дні
      if (chance(0.3)) await page.locator('.note-tags .card').click({ timeout: 1500 }).catch(() => {});  // картка дня
      await page.waitForTimeout(chance(0.3) ? 600 : 50);
      await page.keyboard.press('Escape');
    }
    const more = page.locator('#cal .v-more').first();                    // телефон: аркуш дня
    if (mobile && await more.count()) {
      await more.tap({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(150);
      if (chance(0.5)) await page.locator('#modNav .mnav:not([disabled])').first().tap({ timeout: 1500 }).catch(() => {});
      if (chance(0.4)) { await page.locator('.note-tags .card').tap({ timeout: 1500 }).catch(() => {}); await page.waitForTimeout(500); }
      await page.locator('#vidModal .close').tap({ timeout: 1500 }).catch(() => {});
    }
    if (await page.locator('#since .act').count() && chance(0.5)) {      // «дивитися підряд»
      await page.locator('#since .act').click({ timeout: 1500 }).catch(() => {}); await page.waitForTimeout(150); await page.keyboard.press('Escape');
    }
    const myd = page.locator('.cal-acts .act:has-text("Мій день")');    // «мій день» з випадковою датою
    if (await myd.count() && chance(0.5)) {
      await myd.click({ timeout: 1500 }).catch(() => {});
      await page.selectOption('#mdD', String(int(1, 31)), { timeout: 1500 }).catch(() => {});
      await page.selectOption('#mdM', String(int(1, 12)), { timeout: 1500 }).catch(() => {});
      await page.locator('.md-go').click({ timeout: 1500 }).catch(() => {}); await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
    }
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push('горизонтальний скрол після дій');
  } catch (e) { problems.push('EXC: ' + e.message.split('\n')[0]); }
  await ctx.close();
  return problems.length ? { i, url, vw, problems, cfg: JSON.stringify(cfg).slice(0, 400) } : null;
}

// ── Бот ──
function botRuns(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-zbir-'));
  fs.mkdirSync(path.join(dir, 'tools'));
  ['zbir.mjs', 'mono.mjs'].forEach(f => fs.copyFileSync(path.join(ROOT, 'tools', f), path.join(dir, 'tools', f)));
  fs.copyFileSync(path.join(ROOT, 'seasons.json'), path.join(dir, 'seasons.json'));
  fs.writeFileSync(path.join(dir, 'fx.json'), JSON.stringify({ AbC123xyz: { raised: 18500.5, goal: 50000, title: 'Дрон', about: 'Мавік' }, Q1w2e3r4: { raised: 0, goal: 0, title: '' }, Bad0001: 'fail' }));
  const PARTS = ['/zbir', '/zbir@GavriilBot', '/zakryty', '/zbory', '/start', '', 'https://send.monobank.ua/jar/AbC123xyz', 'send.monobank.ua/jar/Q1w2e3r4',
    'https://send.monobank.ua/jar/Bad0001', 'https://send.monobank.ua/jar/XXXXXXXXXX', 'AbC123xyz', 'dron', 'Дрон для бригади', 'генератор', 'благодійний', 'на канал',
    'ціль 50000', 'ціль 50 000 грн', 'ціль 60к', 'ціль -5', 'мета 1,5', 'до 31.12', 'до 31 грудня', 'до 2026-02-30', 'до 01.01.2020', 'до 15.01', '|', '\n', '\n', ' ', ',',
    ...NASTY.filter(x => typeof x === 'string').map(x => x.slice(0, 300))];
  const bad = [];
  for (let i = 0; i < n; i++) {
    const text = Array.from({ length: int(1, 6) }, () => pick(PARTS)).join(pick([' ', '\n', ' | ']));
    const extra = chance(0.2) ? { ZBIR_ACTION: pick(['add', 'close', 'list', 'видалити', '']), ZBIR_GOAL: pick(['', '50000', 'багато']), ZBIR_UNTIL: pick(['', '31.12', 'вчора']),
      ZBIR_URL: pick(['', 'AbC123xyz', 'javascript:alert(1)']), ZBIR_KIND: pick(['', 'charity', 'дивний']), ZBIR_TITLE: pick(['', String(nasty()).slice(0, 200)]) } : {};
    const msgF = path.join(dir, 'msg.txt'); fs.rmSync(msgF, { force: true });
    const p = cp.spawnSync('node', [path.join(dir, 'tools/zbir.mjs')], { encoding: 'utf8', env: Object.assign({}, process.env,
      { MONO_FIXTURE: path.join(dir, 'fx.json'), MONO_TOKEN: '', ZBIR_TODAY: '2026-09-29', ZBIR_TEXT: text, ZBIR_MESSAGE: msgF, GITHUB_OUTPUT: '' }, extra) });
    const msg = fs.existsSync(msgF) ? fs.readFileSync(msgF, 'utf8') : '';
    let cfg = null, why = [];
    try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'seasons.json'), 'utf8')); } catch (e) { why.push('seasons.json зіпсовано'); }
    if (![0, 1].includes(p.status)) why.push('код виходу ' + p.status);
    if (/\n\s+at /.test(p.stderr)) why.push('стек помилки: ' + p.stderr.split('\n').slice(0, 3).join(' | '));
    if (!/^[✅❌]/.test(msg)) why.push('нема відповіді ✅/❌');
    ((cfg && cfg.support && cfg.support.fundraisers) || []).forEach(f => {
      if (!/^[a-z0-9-]+$/.test(String(f.id))) why.push('якір ' + JSON.stringify(f.id));
      if (!/^https:\/\/send\.monobank\.ua\/jar\/[A-Za-z0-9]+$/.test(String(f.url)) && !/X{10}/.test(String(f.url))) why.push('url ' + JSON.stringify(f.url));
      if (typeof f.goal !== 'number' || !(f.goal >= 0)) why.push('goal ' + JSON.stringify(f.goal));
      if (f.until && !/^\d{4}-\d{2}-\d{2}$/.test(f.until)) why.push('until ' + JSON.stringify(f.until));
    });
    if (why.length) bad.push({ i, text: text.slice(0, 200), extra, why, msg: msg.slice(0, 200) });
  }
  return bad;
}

(async () => {
  console.log(`seed ${SEED}: сайт ×${N_SITE}, бот ×${N_BOT}`);
  const botBad = botRuns(N_BOT);
  console.log(`бот: ${N_BOT - botBad.length}/${N_BOT} чисто`);
  botBad.slice(0, 8).forEach(b => console.log('  ✗ бот', JSON.stringify(b)));
  const browser = await chromium.launch(EXE);
  const siteBad = [];
  for (let i = 0; i < N_SITE; i++) { const b = await siteRun(browser, i); if (b) siteBad.push(b); }
  console.log(`сайт: ${N_SITE - siteBad.length}/${N_SITE} чисто`);
  siteBad.slice(0, 8).forEach(b => console.log('  ✗ сайт', JSON.stringify(b)));
  await browser.close(); server.close();
  process.exit(botBad.length || siteBad.length ? 1 : 0);
})();
