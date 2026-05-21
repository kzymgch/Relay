// Tiny subsequence-based fuzzy scorer for the command palette.
//
// Behaviour:
// - Case-insensitive match (lowercase fold).
// - Empty query matches every candidate at score 0 (so the palette can show
//   the full list with no filter).
// - Mismatch returns `null` so the caller can drop the row.
// - Consecutive-run bonus + word-boundary bonus mean "save" matches
//   "Save current layout" higher than "S_e_arch a_v_ailable".
// - Score is monotonic in match quality; ordering is what matters, the
//   absolute numbers are an implementation detail.

export interface FuzzyMatch {
  /** Higher = better. Use for sort. */
  score: number;
  /** Indexes (in the original candidate string) of matched characters. */
  matched: number[];
}

const CONSECUTIVE_BONUS = 12;
const WORD_BOUNDARY_BONUS = 8;
const CAMEL_BOUNDARY_BONUS = 6;
const LEADING_BONUS = 5;
const GAP_PENALTY = 1;

function isWordBoundary(prev: string | undefined, ch: string): boolean {
  if (prev === undefined) return true;
  if (/\s|[-_/.]/.test(prev)) return true;
  // Lowercase-then-uppercase = camel boundary; treat as a softer bonus.
  if (prev === prev.toLowerCase() && ch === ch.toUpperCase() && ch !== ch.toLowerCase())
    return true;
  return false;
}

export function fuzzyMatch(candidate: string, query: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, matched: [] };
  const cand = candidate;
  const candLower = candidate.toLowerCase();
  const queryLower = query.toLowerCase();

  const matched: number[] = [];
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -2;

  for (let ci = 0; ci < candLower.length && qi < queryLower.length; ci++) {
    if (candLower[ci] === queryLower[qi]) {
      const prev = ci > 0 ? cand[ci - 1] : undefined;
      const ch = cand[ci]!;
      let chBonus = 1;
      if (ci === 0) chBonus += LEADING_BONUS;
      if (isWordBoundary(prev, ch)) {
        chBonus +=
          prev !== undefined && /\s|[-_/.]/.test(prev) ? WORD_BOUNDARY_BONUS : CAMEL_BOUNDARY_BONUS;
      }
      if (ci === lastMatchIdx + 1) chBonus += CONSECUTIVE_BONUS;
      score += chBonus;
      matched.push(ci);
      lastMatchIdx = ci;
      qi += 1;
    } else if (matched.length > 0) {
      // Each unmatched character after the first hit costs a tiny amount so
      // dense matches outrank scattered ones with the same letters.
      score -= GAP_PENALTY;
    }
  }

  if (qi < queryLower.length) return null;
  return { score, matched };
}
