/**
 * Small fuzzy matcher tuned for CellXplorer object names.
 *
 * Library scorers do poorly on long delimiter-heavy scientific names such as
 * `ME_20260512_LFP_LPMoL_611_FM+CYFC_25C`. This scorer ranks by how the query
 * lands on the target rather than by raw edit distance:
 *
 *   1. exact match            2. prefix          3. contiguous substring
 *   4. all query words found  5. scattered subsequence
 *
 * Matches at a word boundary (start, or after one of `_ - + . / space`) score
 * higher, so typing `611` or `lpmol 611` finds the cell above incidental
 * matches inside other digits.
 */

const BOUNDARY = /[\s_\-+./\\()[\]]/;

export interface FuzzyMatch {
  score: number;
  /** Indices of matched characters in the original target, for highlighting. */
  indices: number[];
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return BOUNDARY.test(text[index - 1]);
}

/** Score a single query term against a target. Returns null when unmatched. */
function scoreTerm(target: string, lower: string, term: string): FuzzyMatch | null {
  if (!term) return { score: 0, indices: [] };

  const exactAt = lower.indexOf(term);
  if (exactAt >= 0) {
    const indices: number[] = [];
    for (let i = 0; i < term.length; i += 1) indices.push(exactAt + i);
    // Contiguous run: strong base, plus bonuses for prefix / word start.
    let score = 120 + term.length * 4;
    if (exactAt === 0) score += 40;
    else if (isBoundary(target, exactAt)) score += 25;
    // Slight preference for matches that cover more of a short target.
    score += Math.round((term.length / Math.max(lower.length, 1)) * 20);
    return { score, indices };
  }

  // Scattered subsequence: every character in order, rewarding runs and
  // word-boundary hits.
  const indices: number[] = [];
  let cursor = 0;
  let score = 0;
  let run = 0;
  for (const character of term) {
    const found = lower.indexOf(character, cursor);
    if (found < 0) return null;
    if (found === cursor && indices.length > 0) {
      run += 1;
      score += 6 + run * 2;
    } else {
      run = 0;
      score += 2;
    }
    if (isBoundary(target, found)) score += 8;
    indices.push(found);
    cursor = found + 1;
  }
  // Penalise sprawling matches so tight ones win.
  const span = indices[indices.length - 1] - indices[0] + 1;
  score -= Math.min(30, Math.max(0, span - term.length));
  return { score, indices };
}

/**
 * Score a whitespace-separated query against a target. Every term must match;
 * the result combines term scores and keeps all matched indices.
 */
export function fuzzyScore(target: string, query: string): FuzzyMatch | null {
  const trimmed = query.trim();
  if (!trimmed) return { score: 0, indices: [] };
  const lower = target.toLowerCase();
  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);

  let total = 0;
  const indices = new Set<number>();
  for (const term of terms) {
    const match = scoreTerm(target, lower, term);
    if (!match) return null;
    total += match.score;
    match.indices.forEach((index) => indices.add(index));
  }
  // Whole-query contiguous match is the strongest possible signal.
  if (terms.length > 1 && lower.includes(trimmed.toLowerCase())) total += 60;
  return { score: total, indices: [...indices].sort((a, b) => a - b) };
}

/** Split a target into matched / unmatched segments for highlighting. */
export function highlightSegments(
  target: string,
  indices: number[],
): { text: string; matched: boolean }[] {
  if (indices.length === 0) return [{ text: target, matched: false }];
  const flags = new Set(indices);
  const segments: { text: string; matched: boolean }[] = [];
  let current = "";
  let currentMatched = flags.has(0);
  for (let i = 0; i < target.length; i += 1) {
    const matched = flags.has(i);
    if (matched !== currentMatched && current) {
      segments.push({ text: current, matched: currentMatched });
      current = "";
    }
    currentMatched = matched;
    current += target[i];
  }
  if (current) segments.push({ text: current, matched: currentMatched });
  return segments;
}
