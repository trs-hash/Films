// Швидкість завантаження головної: телефон на повільному 4G (1,6 Мбіт/с, RTT 150 мс, CPU ×4) і ноутбук (10 Мбіт/с).
// Сервер — як GitHub Pages (gzip, Cache-Control: max-age=600); YouTube API й мініатюри — підмінні JPEG справжніх
// розмірів (mq/hq/sd/maxres) із затримкою за розміром. seasons.json — справжній, але старт календаря й сезону —
// 24 дні тому, щоб на стіні були дні. Запуск:  node tests/perf.js        (медіана з 3 холодних візитів)
// Числа — для порівняння «до/після» на одній машині, не абсолютні.
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const EXE = fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
const ROOT = path.resolve(__dirname, '..');
const DAY = 864e5, today = new Date(), ymd = t => t.toISOString().slice(0, 10), start = ymd(new Date(today - 24 * DAY));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'seasons.json'), 'utf8'));
if (cfg.calendar) Object.assign(cfg.calendar, { enabled: true, start });
(cfg.seasons || []).forEach(s => { s.start = start; s.end = ymd(new Date(+today + 340 * DAY)); });
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  let f = path.join(ROOT, p), body;
  if (p === '/seasons.json') body = Buffer.from(JSON.stringify(cfg));
  else if (fs.existsSync(f) && fs.statSync(f).isFile()) body = fs.readFileSync(f);
  else { res.writeHead(404); return res.end(); }
  let type = TYPES[path.extname(f)] || 'text/html; charset=utf-8', h = { 'Content-Type': type, 'Cache-Control': 'max-age=600' };
  if (/text|json|javascript|manifest/.test(type) && /gzip/.test(req.headers['accept-encoding'] || '')) { body = zlib.gzipSync(body, { level: 9 }); h['Content-Encoding'] = 'gzip'; }
  res.writeHead(200, h); res.end(body);
}).listen(8768);
const items = Array.from({ length: 24 }, (_, i) => { const id = 'vid' + String(i).padStart(8, '0'), d = new Date(Date.parse(start + 'T15:00:00Z') + i * DAY);
  const th = (k, f, w, h) => [k, { url: `https://i.ytimg.com/vi/${id}/${f}.jpg`, width: w, height: h }];
  return { snippet: { title: 'День ' + (i + 1) + ': прогулянка містом', description: 'Короткий опис дня. #київ', resourceId: { videoId: id },
    thumbnails: Object.fromEntries([th('medium', 'mqdefault', 320, 180), th('high', 'hqdefault', 480, 360), th('standard', 'sddefault', 640, 480), th('maxres', 'maxresdefault', 1280, 720)]) },
    contentDetails: { videoId: id, videoPublishedAt: d.toISOString() }, status: { privacyStatus: 'public' } }; }).reverse();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function jpegs(b) {                                  // фото-подібний шум → JPEG у розмірах YouTube (~17/40/68/250 КБ)
  const p = await b.newPage();
  const out = await p.evaluate(() => { const mk = (w, h, q, lb) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, w, h); const top = lb ? h * .125 : 0, hh = lb ? h * .75 : h;
      const gr = g.createLinearGradient(0, top, w, top + hh); gr.addColorStop(0, '#c0563a'); gr.addColorStop(1, '#203040'); g.fillStyle = gr; g.fillRect(0, top, w, hh);
      for (let i = 0; i < 400; i++) { g.fillStyle = `hsla(${Math.random() * 360},40%,${30 + Math.random() * 40}%,.35)`; g.beginPath(); g.arc(Math.random() * w, top + Math.random() * hh, Math.random() * w / 12, 0, 7); g.fill(); }
      const d = g.getImageData(0, top, w, hh); for (let i = 0; i < d.data.length; i += 4) { const n = (Math.random() - .5) * 38; d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; } g.putImageData(d, 0, top);
      return c.toDataURL('image/jpeg', q).split(',')[1]; };
    return { mq: mk(320, 180, .8), hq: mk(480, 360, .8, 1), sd: mk(640, 480, .8, 1), maxres: mk(1280, 720, .82) }; });
  await p.close();
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
}
async function visit(b, prof, JPG) {
  const ctx = await b.newContext({ viewport: prof.vp, deviceScaleFactor: prof.dpr, isMobile: prof.mobile, hasTouch: prof.mobile, serviceWorkers: 'block', timezoneId: 'Europe/Kyiv' });
  const page = await ctx.newPage(), cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: prof.rtt, downloadThroughput: prof.down / 8, uploadThroughput: prof.down / 16 });
  if (prof.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: prof.cpu });
  let bytes = 0, reqs = 0;
  cdp.on('Network.loadingFinished', e => { bytes += e.encodedDataLength; reqs++; });
  const slow = n => sleep(prof.rtt * 2 + n / (prof.down / 8) * 1000);   // зовнішні сервери: з’єднання + передача
  await ctx.route(/googleapis\.com/, async r => { const body = JSON.stringify(/UU/.test(r.request().url()) ? { items } : { items: [] }); await slow(Buffer.byteLength(body) * .25 + 200); r.fulfill({ contentType: 'application/json', body }); });
  await ctx.route(/i\.ytimg\.com/, async r => { const k = { mqdefault: 'mq', hqdefault: 'hq', sddefault: 'sd', maxresdefault: 'maxres' }[r.request().url().split('/').pop().replace('.jpg', '')] || 'mq';
    await slow(JPG[k].length); r.fulfill({ contentType: 'image/jpeg', body: JPG[k] }); });
  await ctx.route(/youtube\.com/, r => r.fulfill({ body: '' }));
  await page.addInitScript(() => { window.__lcp = 0; window.__img = 0;
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    document.addEventListener('load', e => { if (e.target.tagName === 'IMG' && !window.__img) window.__img = performance.now(); }, true); });
  await page.goto('http://localhost:8768/', { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#cal .v-lnk').length > 0, null, { timeout: 30000 }).catch(() => {});
  await sleep(2500);
  const m = await page.evaluate(() => ({ fcp: (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || 0, lcp: window.__lcp, img: window.__img,
    api: Math.round((performance.getEntriesByType('resource').find(r => /playlistItems/.test(r.name)) || {}).startTime || 0),
    fonts: performance.getEntriesByType('resource').filter(r => /woff2/.test(r.name)).reduce((a, r) => a + (r.encodedBodySize || 0), 0) }));
  await ctx.close();
  return Object.assign(m, { kb: Math.round(bytes / 1024), reqs });
}
(async () => {
  const b = await chromium.launch(EXE), JPG = await jpegs(b);
  const PROFS = [{ name: 'телефон, повільний 4G, CPU×4', vp: { width: 390, height: 844 }, dpr: 3, mobile: true, rtt: 150, down: 1.6e6, cpu: 4 },
    { name: 'ноутбук, 10 Мбіт/с', vp: { width: 1280, height: 800 }, dpr: 1, mobile: false, rtt: 40, down: 10e6, cpu: 1 }];
  for (const p of PROFS) {
    const runs = []; for (let i = 0; i < 3; i++) runs.push(await visit(b, p, JPG));
    const med = k => Math.round(runs.map(r => r[k]).sort((x, y) => x - y)[1]);
    console.log(`${p.name}: FCP ${med('fcp')} мс · LCP ${med('lcp')} мс · перший кадр стіни ${med('img')} мс · запит до YouTube з ${med('api')} мс · ` +
      `${runs[1].kb} КБ / ${runs[1].reqs} запитів · шрифти ${Math.round(runs[1].fonts / 1024)} КБ`);
  }
  await b.close(); server.close();
})();
