// Generic fallback: press a key until the screen stops changing.
import { pressKey, sleep } from './util.js';

export default {
  name: 'keys',
  description: 'any deck driven by a key (default ArrowRight); stops when the screen stops changing',
  detect: 'true',
  settle: 400,

  async *walk(page, ctx) {
    await page.eval('document.body && document.body.focus(); true');
    let prev = null, prevHref = null, same = 0, pages = 0;
    for (;;) {
      const snap = await ctx.snapshot();
      const href = await page.eval('location.href').catch(() => '');
      if (prev && snap.equals(prev) && href === prevHref) {
        if (++same >= 3) break;
      } else {
        same = 0;
        prev = snap;
        prevHref = href;
        pages++;
        yield { image: await ctx.capture() };
        if (pages >= ctx.maxPages) { ctx.warn(`stopped at --max-pages ${ctx.maxPages}`); break; }
      }
      await pressKey(page, ctx.key);
      await sleep(ctx.settle);
    }
    if (pages === 1) ctx.warn(`only one page captured — the deck may not react to ${ctx.key}; try --key Space or --settle 1000`);
  },
};
