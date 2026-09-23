// Slide Studio decks: fixed-canvas runtime exposing window.deck.state and #N.K hashes.
import { nextFrames } from './util.js';

const goto = (hash, slide, step) => `new Promise((resolve, reject) => {
  location.hash = ${JSON.stringify(hash)};
  const t0 = performance.now();
  (function check() {
    const s = window.deck.state;
    if (s.slide === ${slide} && s.step === ${step}) return resolve(true);
    if (performance.now() - t0 > 5000) return reject(new Error('deck did not move to ${hash}'));
    setTimeout(check, 10);
  })();
})`;

export default {
  name: 'studio',
  description: 'Slide Studio decks (window.deck)',
  detect: '!!(window.deck && window.deck.state && window.deck.state.slides.length > 0)',
  settle: 0,

  async *walk(page, ctx) {
    await page.eval('document.documentElement.classList.add("no-motion"); true');
    const maxSteps = await page.eval('window.deck.state.slides.map(s => s.maxStep)');
    const notes = await page.eval('[...document.querySelectorAll(".deck > section")].map(s => (s.querySelector("aside.notes")?.innerText || "").trim())');
    for (let i = 0; i < maxSteps.length; i++) {
      const max = maxSteps[i], slide = i + 1;
      const steps = ctx.final ? [max] : Array.from({ length: max + 1 }, (_, k) => k);
      for (const step of steps) {
        await page.eval(goto(step > 0 ? `#${slide}.${step}` : `#${slide}`, slide, step), { awaitPromise: true });
        await nextFrames(page);
        yield { image: await ctx.capture(), slideKey: String(slide), step, maxStep: max, notes: notes[i] };
      }
    }
  },
};
