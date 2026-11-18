// Google Meet updates a caption block in place while someone talks:
//   - the text grows as they keep speaking,
//   - recent words get revised as recognition improves,
//   - on long turns the oldest words are trimmed from the front of the block.
// mergeCaptionText(prev, next) combines what we already have (prev) with the newest snapshot
// of the block (next). Rule: never drop words we already captured unless `next` clearly
// replaces them with a revised version.

const normWord = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
const words = (s) => s.split(/\s+/).filter(Boolean);

/**
 * Find the longest run of identical words shared by prev and next (prev's last word may be a
 * cut-off prefix of next's word, e.g. "every" -> "everyone"). Ties go to the run that ends
 * closest to the end of prev, because next is a later view of the same speech.
 */
function bestAnchor(pn, nn) {
  let best = { i: -1, j: -1, len: 0 };
  const same = (i, j) => pn[i] === nn[j] || (i === pn.length - 1 && pn[i].length > 0 && nn[j].startsWith(pn[i]));
  // A snapshot can only overlap the most recent part of what we have.
  const from = Math.max(0, pn.length - nn.length - 20);
  for (let i = from; i < pn.length; i++) {
    for (let j = 0; j < nn.length; j++) {
      let len = 0;
      while (i + len < pn.length && j + len < nn.length && same(i + len, j + len)) len++;
      if (len > best.len || (len === best.len && len > 0 && i + len > best.i + best.len)) best = { i, j, len };
    }
  }
  return best;
}

export function mergeCaptionText(prev, next) {
  prev = (prev || '').trim();
  next = (next || '').trim();
  if (!prev) return next;
  if (!next || next === prev) return prev;

  const pw = words(prev);
  const nw = words(next);
  const pn = pw.map(normWord);
  const nn = nw.map(normWord);

  const anchor = bestAnchor(pn, nn);
  const minRun = pn.length <= 3 ? 1 : Math.min(3, nn.length);
  if (anchor.len >= minRun) {
    // Words of next before the anchor are a (possibly revised) version of the same number of
    // words before the anchor in prev. Everything earlier in prev is kept.
    const keep = Math.max(0, anchor.i - anchor.j);
    let merged = [...pw.slice(0, keep), ...nw];
    // next stops where the anchor ends but prev went on: keep those words rather than lose them.
    const prevTail = pw.slice(anchor.i + anchor.len);
    const nextTail = nw.slice(anchor.j + anchor.len);
    if (nextTail.length === 0 && prevTail.length >= 4) merged = [...merged, ...prevTail];
    return merged.join(' ');
  }

  // No reliable overlap: keep both so nothing is lost.
  return `${prev} ${next}`;
}

// True when `next` looks like a re-render of an existing caption `prev` (same opening words,
// or prev contains next's opening words).
export function looksLikeContinuation(prev, next) {
  const pn = words(prev || '').map(normWord).filter(Boolean);
  const nn = words(next || '').map(normWord).filter(Boolean);
  if (!pn.length || !nn.length) return false;
  const head = (arr, n) => arr.slice(0, n).join(' ');
  const n = Math.min(4, pn.length, nn.length);
  if (head(pn, n) === head(nn, n)) return true;
  const pj = ` ${pn.join(' ')} `;
  return nn.length >= 4 && pj.includes(` ${head(nn, 4)} `);
}

export const wordCount = (s) => words(s || '').length;
