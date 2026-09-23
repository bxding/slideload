export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait n animation frames so the DOM has painted.
export const nextFrames = (page, n = 2) =>
  page.eval(`new Promise(r => { let i = ${n}; (function f(){ if (--i <= 0) return r(true); requestAnimationFrame(f); })(); })`, { awaitPromise: true });

export const KEYS = {
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
};

export function keyDef(name) {
  if (KEYS[name]) return KEYS[name];
  if (name.length === 1) return { key: name, code: 'Key' + name.toUpperCase(), vk: name.toUpperCase().charCodeAt(0), text: name };
  throw new Error(`unknown key "${name}" (use ${Object.keys(KEYS).join(', ')} or a single character)`);
}

export async function pressKey(page, name) {
  const k = keyDef(name);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
