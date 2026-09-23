// Find a Chromium-based browser, launch it with remote debugging, and talk CDP
// over the built-in WebSocket (Bun and Node >= 22). No dependencies.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import os from 'node:os';

const CANDIDATES = {
  darwin: [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['brave-browser', 'brave', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
  win32: [
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
};

function onPath(name) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    const p = join(dir, name);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

export function findBrowser(explicit) {
  const pick = explicit || process.env.SLIDELOAD_BROWSER;
  if (pick) {
    if (existsSync(pick)) return pick;
    throw new Error(`browser not found: ${pick}`);
  }
  for (const c of CANDIDATES[process.platform] || []) {
    const p = c.includes('/') || c.includes('\\') ? (existsSync(c) ? c : null) : onPath(c);
    if (p) return p;
  }
  throw new Error('no Brave/Chrome/Chromium found. Pass --browser <path to executable>.');
}

export const defaultProfileDir = () => join(os.homedir(), '.slideload', 'profile');

export function launch({ browser, profileDir, headed = false, timeoutMs = 15000 }) {
  mkdirSync(profileDir, { recursive: true });
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-features=Translate,BraveRewards,BraveVPN',
    '--hide-scrollbars',
    '--window-size=1920,1080',
    ...(headed ? [] : ['--headless=new']),
    'about:blank',
  ];
  const proc = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const kill = () => { if (proc.exitCode === null) proc.kill('SIGKILL'); };
  process.on('exit', kill);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { kill(); process.exit(130); });

  const wsUrl = new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`browser did not start within ${timeoutMs}ms\n${buf}`)), timeoutMs);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); proc.stderr.removeAllListeners('data'); proc.stderr.resume(); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`browser exited with code ${code}\n${buf}`)); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  return { proc, wsUrl, kill };
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (ev) => this.#onMessage(ev.data);
    ws.onclose = () => { for (const p of this.pending.values()) p.reject(new Error('CDP connection closed')); this.pending.clear(); };
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new CDP(ws));
      ws.onerror = () => reject(new Error(`could not connect to ${url}`));
    });
  }

  #onMessage(data) {
    const msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString());
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
    } else {
      for (const fn of this.listeners.get(msg.method) || []) fn(msg.params, msg.sessionId);
    }
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no response from the browser within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  // Open a new tab and return a bound sender for it.
  async newPage() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = {
      send: (method, params, timeoutMs) => this.send(method, params, sessionId, timeoutMs),
      async eval(expression, { awaitPromise = false } = {}, timeoutMs) {
        const r = await page.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, timeoutMs);
        if (r.exceptionDetails) {
          const ex = r.exceptionDetails;
          throw new Error(ex.exception?.description || ex.text || 'evaluate failed');
        }
        return r.result.value;
      },
    };
    return page;
  }

  close() { try { this.ws.close(); } catch {} }
}
