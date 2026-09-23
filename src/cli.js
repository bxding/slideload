#!/usr/bin/env bun
// slideload — capture a web slide deck (every slide and build step) into a PDF.
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { CDP, defaultProfileDir, findBrowser, launch } from './browser.js';
import { byName, drivers, fallback } from './drivers/index.js';
import { sleep } from './drivers/util.js';
import { writePdf } from './pdf.js';
import { mergePdfs } from './pdfmerge.js';

const HELP = `usage: slideload <url> [options]   (alias: sl)

  -o, --out <file>      output PDF (default: <last url segment>.pdf)
      --final           one page per slide (last build step only); ignored by the keys driver
      --notes           also write <out>.notes.md with speaker notes (when the deck exposes them)
      --driver <name>   force a driver: ${[...drivers, fallback].map((d) => d.name).join(', ')} (default: auto-detect)
      --key <name>      key the keys driver presses (default ArrowRight; e.g. Space, PageDown, n)
      --settle <ms>     wait after each move before capturing (default depends on driver)
      --max-pages <n>   safety cap on captured pages (default 500)
      --raster          screenshot pages (JPEG) instead of vector PDF pages with selectable text
      --quality <1-100> JPEG quality for --raster (default 90)
      --scale <n>       device scale factor for --raster, 2 = retina (default 1)
      --headed          show the browser window (log in once; the profile is kept)
      --browser <path>  browser executable (default: Brave, then Chrome/Chromium/Edge)
      --profile <dir>   browser profile dir (default: ~/.slideload/profile)
      --timeout <ms>    how long to wait for a known slide framework before falling back (default 15000)
  -h, --help

drivers:
${[...drivers, fallback].map((d) => `  ${d.name.padEnd(8)} ${d.description}`).join('\n')}
`;

function parseArgs(argv) {
  const o = { quality: 90, scale: 1, timeout: 15000, maxPages: 500, key: 'ArrowRight', final: false, notes: false, headed: false, raster: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '-o' || a === '--out') o.out = next();
    else if (a === '--final') o.final = true;
    else if (a === '--notes') o.notes = true;
    else if (a === '--raster') o.raster = true;
    else if (a === '--headed') o.headed = true;
    else if (a === '--driver') o.driver = next();
    else if (a === '--key') o.key = next();
    else if (a === '--settle') o.settle = Number(next());
    else if (a === '--max-pages') o.maxPages = Number(next());
    else if (a === '--quality') o.quality = Number(next());
    else if (a === '--scale') o.scale = Number(next());
    else if (a === '--timeout') o.timeout = Number(next());
    else if (a === '--browser') o.browser = next();
    else if (a === '--profile') o.profile = next();
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (!o.url) o.url = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!o.url) throw new Error('missing <url>\n\n' + HELP);
  if (!(o.quality >= 1 && o.quality <= 100)) throw new Error('--quality must be 1-100');
  if (!(o.scale > 0)) throw new Error('--scale must be > 0');
  if (!(o.maxPages >= 1)) throw new Error('--max-pages must be >= 1');
  if (o.driver && !byName[o.driver]) throw new Error(`unknown driver ${o.driver}; use one of ${Object.keys(byName).join(', ')}`);
  return o;
}

function normalizeUrl(raw) {
  const u = new URL(raw.includes('://') ? raw : 'https://' + raw);
  if (!u.pathname.endsWith('/') && !/\.[a-z0-9]+$/i.test(u.pathname)) u.pathname += '/';
  return u;
}

const status = (s) => process.stderr.write('\r\x1b[2K' + s);
const warn = (s) => process.stderr.write('\r\x1b[2Kwarning: ' + s + '\n');

async function detectDriver(page, candidates, deadline) {
  for (;;) {
    for (const d of candidates) {
      if (await page.eval(d.detect).catch(() => false)) return d;
    }
    if (Date.now() > deadline) return null;
    await sleep(150);
  }
}

const waitForEnter = () => new Promise((r) => { process.stdin.resume(); process.stdin.once('data', () => { process.stdin.pause(); r(); }); });

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const url = normalizeUrl(opts.url);
  const out = opts.out || (basename(url.pathname.replace(/\/$/, '')) || 'slides') + '.pdf';
  const browserPath = findBrowser(opts.browser);
  const profileDir = opts.profile || defaultProfileDir();

  status(`launching ${basename(browserPath)}…`);
  const { wsUrl, kill } = launch({ browser: browserPath, profileDir, headed: opts.headed });
  const cdp = await CDP.connect(await wsUrl);
  try {
    const page = await cdp.newPage();
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: opts.scale, mobile: false });
    await page.send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

    status(`loading ${url}`);
    const loaded = new Promise((r) => cdp.on('Page.loadEventFired', r));
    await page.send('Page.navigate', { url: url.href });
    await Promise.race([loaded, sleep(opts.timeout)]);

    // Pick a driver: forced, auto-detected, or the generic keys fallback.
    let driver = opts.driver ? byName[opts.driver] : null;
    if (driver !== fallback) {
      const candidates = driver ? [driver] : drivers;
      status('detecting slide framework…');
      let found = await detectDriver(page, candidates, Date.now() + opts.timeout);
      if (!found && opts.headed) {
        status('no slide framework detected (login page?). Get the deck showing in the browser window, then press Enter here.\n');
        await waitForEnter();
        found = await detectDriver(page, candidates, Date.now() + 3000);
      }
      if (!found && driver) throw new Error(`driver "${driver.name}" did not detect a deck at ${url}`);
      if (!found) warn(`no known slide framework detected, falling back to "${fallback.name}" (${opts.key} until the screen stops changing)`);
      driver = found || fallback;
    } else {
      await sleep(1000);
    }
    if (driver === fallback && opts.final) warn('--final has no effect with the keys driver');

    await page.eval('document.fonts.ready.then(() => true)', { awaitPromise: true }).catch(() => {});
    const title = await page.eval('document.title').catch(() => '');

    const ctx = {
      final: opts.final,
      key: opts.key,
      maxPages: opts.maxPages,
      settle: opts.settle ?? driver.settle,
      warn,
      // snapshot: cheap JPEG used by drivers to detect change. capture: the page as it goes into the PDF.
      snapshot: async () => {
        const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, captureBeyondViewport: false });
        return Buffer.from(data, 'base64');
      },
      capture: async () => {
        if (opts.raster) {
          const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: opts.quality, captureBeyondViewport: false });
          return Buffer.from(data, 'base64');
        }
        // Stream the PDF back in chunks: a heavy page can exceed a single WebSocket message.
        const { stream } = await page.send('Page.printToPDF', {
          printBackground: true, paperWidth: 20, paperHeight: 11.25,
          marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
          preferCSSPageSize: false, scale: 1, pageRanges: '1', transferMode: 'ReturnAsStream',
        }, 120000);
        const chunks = [];
        for (;;) {
          const { data, base64Encoded, eof } = await page.send('IO.read', { handle: stream, size: 1 << 20 });
          chunks.push(Buffer.from(data, base64Encoded ? 'base64' : 'latin1'));
          if (eof) break;
        }
        await page.send('IO.close', { handle: stream }).catch(() => {});
        return Buffer.concat(chunks);
      },
    };

    const images = [], notes = [];
    let slideNo = 0, lastKey;
    try {
      for await (const s of driver.walk(page, ctx)) {
        if (s.slideKey === undefined || s.slideKey !== lastKey) { slideNo++; lastKey = s.slideKey; }
        images.push(s.image);
        if (s.notes && notes.at(-1)?.slide !== slideNo) notes.push({ slide: slideNo, text: s.notes });
        status(`[${driver.name}] page ${images.length}: slide ${slideNo}` + (s.maxStep ? ` step ${s.step}/${s.maxStep}` : s.step ? ` step ${s.step}` : ''));
      }
    } catch (e) {
      if (!images.length || !/no response from the browser/.test(e.message)) throw e;
      warn(`the page stopped responding after page ${images.length} (${e.message}); writing what was captured`);
    }
    if (!images.length) throw new Error('nothing captured');

    writeFileSync(out, opts.raster ? writePdf(images, { width: 1920, height: 1080, title }) : mergePdfs(images, { title }));
    status('');
    console.log(`wrote ${out} (${images.length} pages, ${slideNo} slides, ${opts.raster ? 'raster' : 'vector'}, driver: ${driver.name})`);

    if (opts.notes) {
      const notesFile = out.replace(/\.pdf$/i, '') + '.notes.md';
      const md = `# ${title || out}\n\n` + (notes.length ? notes.map((n) => `## Slide ${n.slide}\n\n${n.text}\n`).join('\n') : '_No speaker notes found._\n');
      writeFileSync(notesFile, md);
      console.log(`wrote ${notesFile}`);
    }
  } finally {
    await cdp.send('Browser.close', {}, undefined, 3000).catch(() => {});
    cdp.close();
    setTimeout(kill, 1500).unref();
  }
}

main().catch((e) => {
  status('');
  console.error(`slideload: ${e.message}`);
  process.exit(1);
});
