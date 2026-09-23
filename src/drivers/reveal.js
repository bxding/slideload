// reveal.js decks (3.x / 4.x / 5.x) via the global Reveal API.
import { nextFrames, sleep } from './util.js';

const STATE = `(() => {
  const i = Reveal.getIndices();
  const frag = Reveal.availableFragments ? Reveal.availableFragments() : { next: false };
  return {
    key: i.h + '.' + i.v,
    step: (i.f == null || i.f < 0) ? 0 : i.f + 1,
    hasNextFragment: !!frag.next,
    last: Reveal.isLastSlide(),
    notes: (Reveal.getSlideNotes && Reveal.getSlideNotes()) || '',
  };
})()`;

export default {
  name: 'reveal',
  description: 'reveal.js decks (window.Reveal)',
  detect: '!!(window.Reveal && typeof Reveal.getIndices === "function" && (typeof Reveal.isReady !== "function" || Reveal.isReady()))',
  settle: 150,

  async *walk(page, ctx) {
    await page.eval(`Reveal.configure({ transition: 'none', backgroundTransition: 'none', autoAnimate: false, autoSlide: 0 }); Reveal.slide(0, 0, 0); true`);
    await nextFrames(page);
    await sleep(ctx.settle);
    for (let n = 0; ; n++) {
      const st = await page.eval(STATE);
      const end = st.last && !st.hasNextFragment;
      if (!ctx.final || !st.hasNextFragment) {
        yield { image: await ctx.capture(), slideKey: st.key, step: st.step, notes: st.notes.trim() };
      }
      if (end || n >= ctx.maxPages) break;
      await page.eval('Reveal.next(); true');
      await nextFrames(page);
      await sleep(ctx.settle);
    }
  },
};
