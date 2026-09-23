import studio from './studio.js';
import reveal from './reveal.js';
import keys from './keys.js';

// Order matters: the first driver whose `detect` expression is true wins.
export const drivers = [studio, reveal];
export const fallback = keys;
export const byName = Object.fromEntries([...drivers, keys].map((d) => [d.name, d]));
