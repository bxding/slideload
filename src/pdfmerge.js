// Merge single-page PDFs produced by Chrome's Page.printToPDF into one document.
import { createHash } from 'node:crypto';
// Chrome (Skia) writes PDF 1.4 with a classic xref table, no object streams and
// direct /Length values, which is all this parser handles.

const latin1 = (buf, a, b) => buf.toString('latin1', a, b);

// Index of the char after the matching '>>' for a dict starting at `i` ('<<').
function dictEnd(s, i) {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '<' && s[i + 1] === '<') { depth++; i += 2; }
    else if (c === '>' && s[i + 1] === '>') { depth--; i += 2; if (depth === 0) return i; }
    else if (c === '(') { // literal string
      let d = 0;
      for (i++; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue; }
        if (s[i] === '(') d++;
        else if (s[i] === ')') { if (d === 0) { i++; break; } d--; }
      }
    }
    else if (c === '<') { i = s.indexOf('>', i) + 1 || s.length; } // hex string
    else if (c === '%') { i = s.indexOf('\n', i) + 1 || s.length; }
    else i++;
  }
  throw new Error('unterminated dictionary');
}

function parsePdf(buf) {
  const tailText = latin1(buf, Math.max(0, buf.length - 2048));
  const sx = tailText.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
  if (!sx) throw new Error('no startxref');
  const objs = new Map();
  let trailer = null;
  let xrefPos = Number(sx[1]);
  for (let guard = 0; xrefPos >= 0 && guard < 64; guard++) {
    const head = latin1(buf, xrefPos, xrefPos + 32);
    if (!head.startsWith('xref')) throw new Error('xref streams are not supported');
    let p = xrefPos + 4;
    const text = latin1(buf, p, Math.min(buf.length, p + 64 * 1024 * 1024));
    let q = 0;
    for (;;) {
      const m = text.slice(q).match(/^\s*(\d+)\s+(\d+)\s*\n?/);
      if (!m) break;
      if (text.slice(q).match(/^\s*trailer/)) break;
      q += m[0].length;
      const [, startStr, countStr] = m;
      const start = Number(startStr), count = Number(countStr);
      for (let k = 0; k < count; k++) {
        const entry = text.slice(q, q + 20);
        const em = entry.match(/^(\d{10}) (\d{5}) ([nf])/);
        if (!em) throw new Error('bad xref entry');
        q += 20;
        // Chrome writes 20-byte entries, but tolerate 19-byte ones (LF only).
        if (text[q - 1] !== ' ' && text[q - 1] !== '\n' && text[q - 1] !== '\r') q--;
        if (em[3] === 'n' && !objs.has(start + k)) objs.set(start + k, { offset: Number(em[1]) });
      }
    }
    const tm = text.slice(q).match(/^\s*trailer\s*/);
    if (!tm) throw new Error('missing trailer');
    const tStart = p + q + tm[0].length;
    const tText = latin1(buf, tStart, Math.min(buf.length, tStart + 4096));
    const tDict = tText.slice(0, dictEnd(tText, 0));
    if (!trailer) trailer = tDict;
    const prev = tDict.match(/\/Prev\s+(\d+)/);
    xrefPos = prev ? Number(prev[1]) : -1;
  }

  // Parse each object body at its offset.
  for (const [num, o] of objs) {
    const headText = latin1(buf, o.offset, o.offset + 64);
    const hm = headText.match(/^\s*(\d+)\s+(\d+)\s+obj\s*/);
    if (!hm || Number(hm[1]) !== num) throw new Error(`object ${num} not at xref offset`);
    const bodyStart = o.offset + hm[0].length;
    const window = latin1(buf, bodyStart, Math.min(buf.length, bodyStart + 1024 * 1024));
    let dict, stream = null;
    if (window.startsWith('<<')) {
      const end = dictEnd(window, 0);
      dict = window.slice(0, end);
      const rest = window.slice(end, end + 16);
      const sm = rest.match(/^\s*stream(\r\n|\n)/);
      if (sm) {
        const lm = dict.match(/\/Length\s+(\d+)(\s+0\s+R)?/);
        if (!lm) throw new Error(`stream object ${num} has no /Length`);
        let len = Number(lm[1]);
        if (lm[2]) { // indirect length: read that object's number
          const ref = objs.get(len);
          const lt = latin1(buf, ref.offset, ref.offset + 64).match(/obj\s*(\d+)/);
          len = Number(lt[1]);
        }
        const dataStart = bodyStart + end + sm[0].length;
        stream = buf.subarray(dataStart, dataStart + len);
      }
    } else {
      const em = window.indexOf('endobj');
      if (em < 0) throw new Error(`object ${num} has no endobj`);
      dict = window.slice(0, em).trim();
    }
    o.dict = dict;
    o.stream = stream;
  }

  const ref = (dict, key) => { const m = dict.match(new RegExp(`\\/${key}\\s+(\\d+)\\s+0\\s+R`)); return m ? Number(m[1]) : null; };
  const rootNum = ref(trailer, 'Root');
  const root = objs.get(rootNum);
  if (!root) throw new Error('no catalog');
  let pagesNum = ref(root.dict, 'Pages');
  const skip = new Set([rootNum, pagesNum]);
  const infoNum = ref(trailer, 'Info');
  if (infoNum != null) skip.add(infoNum);

  // Descend to the first leaf page, collecting inheritable attributes.
  const inherited = {};
  let node = objs.get(pagesNum), pageNum = pagesNum;
  for (let guard = 0; guard < 32; guard++) {
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      if (inherited[key] == null) {
        const m = node.dict.match(new RegExp(`\\/${key}\\s+`));
        if (m) inherited[key] = extractValue(node.dict, m.index + m[0].length);
      }
    }
    if (/\/Type\s*\/Page\b/.test(node.dict)) break;
    const kids = node.dict.match(/\/Kids\s*\[\s*(\d+)\s+0\s+R/);
    if (!kids) throw new Error('page tree has no kids');
    skip.add(pageNum);
    pageNum = Number(kids[1]);
    node = objs.get(pageNum);
  }
  return { objs, skip, pageNum, inherited };
}

// Extract one PDF value (dict, array, name, number, ref) starting at index i.
function extractValue(s, i) {
  if (s.startsWith('<<', i)) return s.slice(i, dictEnd(s, i));
  if (s[i] === '[') {
    let d = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '[') d++;
      else if (s[j] === ']') { if (--d === 0) return s.slice(i, j + 1); }
    }
  }
  const m = s.slice(i).match(/^(\d+\s+0\s+R|\/?[^\s\/>\]]+)/);
  return m ? m[1] : '';
}

export function mergePdfs(pdfs, { title } = {}) {
  const out = []; // [{ dict, stream }] in final object order; index+1 = object number
  const pageIds = [];
  const PAGES_ID = 2;
  out.push(null, null); // 1 = catalog, 2 = pages

  const seen = new Map(); // hash of self-contained stream objects -> object number (dedupes images/fonts repeated on every page)

  for (const buf of pdfs) {
    const { objs, skip, pageNum, inherited } = parsePdf(buf);
    const map = new Map();
    let next = out.length + 1;
    for (const [num, o] of objs) {
      if (skip.has(num)) continue;
      if (o.stream && !/\d+\s+0\s+R/.test(o.dict)) {
        const h = createHash('sha1').update(o.dict).update(o.stream).digest('hex');
        if (seen.has(h)) { map.set(num, seen.get(h)); o.dup = true; continue; }
        seen.set(h, next);
      }
      map.set(num, next++);
    }
    const renum = (text) => text.replace(/(\d+)\s+0\s+R\b/g, (m, n) => {
      const to = map.get(Number(n));
      if (to) return `${to} 0 R`;
      return skip.has(Number(n)) ? `${PAGES_ID} 0 R` : 'null';
    });
    for (const [num, o] of objs) {
      if (skip.has(num) || o.dup) continue;
      let dict = o.dict;
      if (num === pageNum) {
        for (const [key, val] of Object.entries(inherited)) {
          if (val != null && !new RegExp(`\\/${key}\\s`).test(dict)) dict = dict.replace(/>>\s*$/, ` /${key} ${val} >>`);
        }
        dict = dict.replace(/\/Parent\s+\d+\s+0\s+R/, `/Parent ${PAGES_ID} 0 R`);
        if (!/\/Parent\s/.test(dict)) dict = dict.replace(/>>\s*$/, ` /Parent ${PAGES_ID} 0 R >>`);
        pageIds.push(map.get(num));
      }
      out.push({ dict: renum(dict), stream: o.stream });
    }
  }

  out[0] = { dict: `<< /Type /Catalog /Pages ${PAGES_ID} 0 R >>` };
  out[1] = { dict: `<< /Type /Pages /Kids [${pageIds.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageIds.length} >>` };
  const safe = (s) => '(' + s.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '?') + ')';
  out.push({ dict: `<< /Producer (slideload)${title ? ' /Title ' + safe(title) : ''} >>` });
  const infoId = out.length;

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets = [];
  out.forEach((o, i) => {
    offsets.push(offset);
    const chunks = [Buffer.from(`${i + 1} 0 obj\n${o.dict}`, 'latin1')];
    if (o.stream) chunks.push(Buffer.from('\nstream\n', 'latin1'), o.stream, Buffer.from('\nendstream', 'latin1'));
    chunks.push(Buffer.from('\nendobj\n', 'latin1'));
    const b = Buffer.concat(chunks);
    parts.push(b);
    offset += b.length;
  });
  const xref = `xref\n0 ${out.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<< /Size ${out.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}
