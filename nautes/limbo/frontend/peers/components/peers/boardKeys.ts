// Fractional index (LexoRank-lite) for the peer board's column/card ordering.
//
// Order keys are base-62 fraction strings compared lexicographically (ASCII
// order == rank order). `keyBetween(a, b)` returns a key strictly between two
// neighbours, with null = "before everything" (lower) / "after everything"
// (upper), so an insert or a move rewrites ONE key instead of renumbering the
// list — which is what keeps two peers' edits from reshuffling each other.
// Inline port of rocicorp's `fractional-indexing` midpoint — zero dependencies.
//
// This lived in the group Kanban board's model until that feature was parked
// (limbo/frontend/kanban/); the peer board is a separate feature and kept its
// own copy rather than depending on parked code.

export const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A key strictly between `a` and `b` (both base-62 fraction strings after an
 *  implicit "0."). `b == null` ⇒ no upper bound; recursion terminates because a
 *  bounded interval always contains a longer/greater string. Requires a < b. */
function midpoint(a: string, b: string | null): string {
  const zero = DIGITS[0];
  if (b != null && a >= b) throw new Error(`board keyBetween: ${a} >= ${b}`);
  if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) {
    throw new Error("board keyBetween: trailing zero");
  }
  if (b) {
    // Copy the shared prefix, then find the midpoint of the remainder.
    let n = 0;
    while ((a[n] || zero) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b != null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) {
    return DIGITS[Math.round(0.5 * (digitA + digitB))];
  }
  // First digits are consecutive.
  if (b && b.length > 1) return b.slice(0, 1);
  // `b` is null or a single digit: descend into `a`'s tail with no upper bound.
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/** Order key strictly between `a` and `b` (existing keys, or null for the open
 *  ends). `keyBetween(null, null)` seeds the first key; `keyBetween(last, null)`
 *  appends; `keyBetween(null, first)` prepends. */
export function keyBetween(a: string | null, b: string | null): string {
  return midpoint(a ?? "", b);
}

/** Evenly-spaced initial keys for `count` seed columns (all > the open lower end). */
export function seedKeys(count: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i++) {
    prev = keyBetween(prev, null);
    out.push(prev);
  }
  return out;
}

export function last<T>(arr: T[]): T | undefined {
  return arr.length ? arr[arr.length - 1] : undefined;
}

/** Columns a peer board starts with. Was `build_config.kanban_default_columns`
 *  until the group board was parked; the peer board is small and local, so the
 *  titles live here rather than in the build config. */
export const PEER_BOARD_DEFAULT_COLUMNS = ["To Do", "In Progress", "Done"];
