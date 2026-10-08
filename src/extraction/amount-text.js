// Pull a THB amount out of free OCR text from a Thai payment slip.
//
// Faithful port of app/extraction/amount_text.py. Shared by the real Vision
// extractor and the stub, so both behave identically once text exists — only
// the source of the text differs.
//
// THE CORE PROBLEM: a slip usually prints TWO numbers — the transfer amount and
// the remaining balance — and the balance is almost always the larger of the
// two. So magnitude must never decide the winner. What decides it is the KIND
// of label attached to that particular number.
//
// ALGORITHM — classification is per NUMBER, not per line
// ------------------------------------------------------
// Thai mobile banking apps (SCB Easy, K PLUS, Krungthai NEXT) usually STACK the
// label above its value, and that is also how Vision's `fullTextAnnotation.text`
// groups them:
//
//     จำนวนเงิน
//     1,250.00 บาท
//     ยอดคงเหลือ
//     45,300.00 บาท
//
// Classifying a whole line at once cannot read that layout: both number lines
// carry only "บาท". So every number is bound to a label individually:
//
// 1. Nearest preceding label on the same line. Each number takes the class of
//    the label occurrence that ENDS closest before it. That resolves the case
//    where one line carries both labels —
//    "จำนวนเงิน 1,250.00 บาท ยอดคงเหลือ 45,300.00 บาท" binds 1,250.00 to
//    จำนวนเงิน and 45,300.00 to ยอดคงเหลือ.
// 2. Label carry-over. A line that carries a label but NO number leaves that
//    label pending for the next number-bearing line. Scope is deliberately
//    tight: the pending label is consumed by the first number-bearing line that
//    follows, is REPLACED by any later label-only line, and SURVIVES at most
//    MAX_CARRY_GAP_LINES intervening non-blank lines that carry neither a label
//    nor a number — it is discarded on the next one after that (with the
//    default of 2: survives 2, dies on the 3rd). So it cannot leak past
//    unrelated content, and an intervening labelled line always wins over a
//    stale one.
// 3. Carry-over never promotes a bare integer. A carried label applies only to
//    a number written with satang or sitting next to a currency unit. Without
//    that, the number falls back to UNLABELED — which is what keeps a reference
//    number on the line after "โอนเงินสำเร็จ" from being read as the amount.
// 4. No label at all → NEUTRAL if a currency unit appears on the line,
//    otherwise UNLABELED.
//
// Candidates are then ranked by CLASS first, then by whether the number is
// written with satang, and only as a final tiebreak by magnitude:
//
//   class 3 POSITIVE  bound to a transfer-amount label (จำนวนเงิน, ยอดชำระ, amount)
//   class 2 NEUTRAL   only a currency unit nearby (บาท, THB) — a unit is not a
//                     claim about WHICH number this is
//   class 1 UNLABELED no label reached it; kept only when it has satang
//   class 0 NEGATIVE  bound to a balance label (ยอดคงเหลือ, คงเหลือ, balance) — a
//                     balance is actively DEMOTED and wins only when the slip
//                     offers nothing else at all
//
// The substring trap — "ยอดเงิน" (positive) sits inside "ยอดเงินคงเหลือ" (a
// balance) — is defused by LATEST-ENDING-WINS, not by the class ordering: the
// positive substring ends at offset 7 while the balance label ends at 14, so
// picking the latest-ending occurrence filters the positive one out before any
// tie-break runs. The negative-first ordering in pickLabel() is a safety net
// for a same-end overlap, which the current keyword lists cannot actually
// produce (a tie requires one keyword to be a suffix of the other, and no
// amount keyword is a suffix of a balance keyword or vice versa).
//
// Bare integers with no decimal point and no label are rejected — those are
// account numbers, reference numbers, and dates.
//
// A balance-only slip DOES return the balance rather than nothing: a number
// that disagrees with the claim is more useful to the reviewer (it becomes a
// MISMATCH they can see) than an UNREADABLE that hides what the OCR read.
//
// NO SILENT FAILURES: whenever the winner is below POSITIVE the returned detail
// carries an explicit WARNING in either of two cases —
//
// * a balance keyword appears anywhere in the text (the specific case: the
//   number we chose may well be that balance), or
// * another candidate of the SAME class exists, i.e. the winner was picked out
//   of a genuine tie between equally-plausible numbers and only the tiebreaks
//   (satang, then magnitude) separated them. This fires whether or not a
//   balance keyword is present.
//
// The pick may stay undecidable from the text; that is acceptable. What is not
// acceptable is returning it as though it were a confident extraction.
//
// KNOWN UNHANDLED LAYOUT (deferred, see the TODO in findAmount): a label-COLUMN
// above a value-COLUMN, where two label-only lines stack before their two
// numbers, still returns the balance. Not every competing-amount layout is
// handled.
//
// PORTING NOTES (behaviour, not algorithm): Python's `\d` and float() accept
// every Unicode decimal digit, so the patterns use \p{Nd} and digits are folded
// to ASCII before conversion. Offsets are UTF-16 code units instead of code
// points; labels and numbers are both located in the same string, so every
// comparison stays consistent.

import { toAsciiDigits } from "../../shared/numbers.js";

// Balance / carried-forward labels. Win ties against amount labels — see above.
export const BALANCE_KEYWORDS = Object.freeze([
  "ยอดคงเหลือ",
  "เงินคงเหลือ",
  "คงเหลือ",
  "ยอดยกมา",
  "ยกมา",
  "available balance",
  "balance",
  "available",
]);

// Labels that genuinely name the amount being transferred / paid.
export const AMOUNT_KEYWORDS = Object.freeze([
  "จำนวนเงิน",
  "จํานวนเงิน", // sara-am variant produced by some OCR engines
  "จำนวน",
  "จํานวน",
  "โอนเงิน",
  "ยอดชำระ",
  "ยอดชําระ",
  "ยอดเงิน",
  "ยอดรวม",
  "รวมทั้งสิ้น",
  "รวมเงิน",
  "amount",
  "total",
]);

// A currency unit alone says nothing about WHICH number it labels: the balance
// line ends in "บาท" too. It is a weak signal, and it trails its number rather
// than preceding it, so it is never treated as a binding label.
export const CURRENCY_UNIT_KEYWORDS = Object.freeze(["บาท", "thb", "baht"]);

export const CLASS_NEGATIVE = 0;
export const CLASS_UNLABELED = 1;
export const CLASS_NEUTRAL = 2;
export const CLASS_POSITIVE = 3;

export const CLASS_NAMES = Object.freeze({
  [CLASS_NEGATIVE]: "balance label",
  [CLASS_UNLABELED]: "no label",
  [CLASS_NEUTRAL]: "currency unit only",
  [CLASS_POSITIVE]: "amount label",
});

// How many non-blank lines carrying neither a label nor a number a pending
// label may survive before it is discarded as stale.
export const MAX_CARRY_GAP_LINES = 2;

// 1,250.00 / 1250.00 / 1,250 / 250
const NUMBER_PATTERN =
  /(?<![\p{Nd}.,])(\p{Nd}{1,3}(?:,\p{Nd}{3})+|\p{Nd}+)(?:\.(\p{Nd}{1,2}))?(?!\p{Nd})/gu;

// Things that are definitely not an amount.
const DATE_PATTERN = /\p{Nd}{1,2}[/-]\p{Nd}{1,2}[/-]\p{Nd}{2,4}/gu;
const TIME_PATTERN = /\p{Nd}{1,2}:\p{Nd}{2}/gu;

// Python str.splitlines() boundaries.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

/**
 * Lowercase for matching, character by character, never changing length.
 *
 * Offsets matter: labels and numbers are located in the same string and
 * compared by position, so the lowered string must stay the same length as the
 * original. A few Unicode characters expand when lowercased (İ U+0130 is the
 * only one that occurs in practice); those single characters are left as they
 * are, and every other character still folds normally — so one stray İ can no
 * longer silently stop the whole line from matching its English labels.
 */
export function lowerSameLength(line) {
  let out = "";
  for (const ch of line) {
    const lowered = ch.toLowerCase();
    out += lowered.length === ch.length ? lowered : ch;
  }
  return out;
}

const codePointLength = (text) => [...text].length;

/** Return the longest keyword present, so the most specific label wins. */
function firstMatch(line, keywords) {
  let best = null;
  for (const keyword of keywords) {
    if (line.includes(keyword) && (best === null || codePointLength(keyword) > codePointLength(best))) {
      best = keyword;
    }
  }
  return best;
}

/**
 * Every balance/amount label found in `line`, as [endOffset, class, keyword].
 *
 * Offsets index into `line` as given, so they can be compared against number
 * match positions from the same string.
 */
export function labelOccurrences(line) {
  const lowered = lowerSameLength(line);
  const found = [];
  for (const [keywords, lineClass] of [
    [BALANCE_KEYWORDS, CLASS_NEGATIVE],
    [AMOUNT_KEYWORDS, CLASS_POSITIVE],
  ]) {
    for (const keyword of keywords) {
      let start = lowered.indexOf(keyword);
      while (start !== -1) {
        found.push([start + keyword.length, lineClass, keyword]);
        start = lowered.indexOf(keyword, start + 1);
      }
    }
  }
  return found;
}

/**
 * Choose one label from occurrences that all qualify: latest-ending wins.
 *
 * LATEST-ENDING-WINS is the substring-trap defense, on its own: in
 * "ยอดเงินคงเหลือ" the positive "ยอดเงิน" ends at 7 and the balance labels end
 * at 14, so the max discards the positive before any tie-break is consulted.
 *
 * The tie-break only settles occurrences that end at the SAME offset, which
 * means one keyword is a suffix of the other:
 *
 * * -length(keyword) reports the more specific spelling ("available balance",
 *   not the "balance" inside it).
 * * class puts NEGATIVE first, so an overlapping balance label can never be
 *   displaced by a positive one.
 *
 * Neither component changes what findAmount returns today: a cross-class tie
 * is impossible with the present lists (no amount keyword is a suffix of a
 * balance keyword or the reverse), and every same-class tie that the lists can
 * produce already lists the longer keyword first, which a stable sort
 * preserves. They are the CONTRACT of this function, so that reordering or
 * extending the keyword lists cannot silently change its answer, and they are
 * pinned by direct unit tests rather than through findAmount.
 */
export function pickLabel(candidates) {
  const latestEnd = Math.max(...candidates.map(([end]) => end));
  const tied = candidates.filter(([end]) => end === latestEnd);
  tied.sort((a, b) => a[1] - b[1] || codePointLength(b[2]) - codePointLength(a[2]));
  const [, lineClass, keyword] = tied[0];
  return [lineClass, keyword];
}

/** Label bound to a number starting at `position`, or null if none precedes it. */
export function nearestPrecedingLabel(occurrences, position) {
  const before = occurrences.filter(([end]) => end <= position);
  if (before.length === 0) return null;
  return pickLabel(before);
}

/**
 * Blank out dates and times so they cannot be read as amounts.
 *
 * Offsets need not be preserved: labelOccurrences() and NUMBER_PATTERN both
 * read the string this returns, so their positions stay consistent with each
 * other no matter how much the substitution shifts them. Only `rawLine` is
 * reported back to the user, and that is never offset-indexed.
 */
function scrub(line) {
  return line.replace(DATE_PATTERN, " ").replace(TIME_PATTERN, " ");
}

function hasBalanceKeyword(text) {
  const lowered = text.toLowerCase();
  return BALANCE_KEYWORDS.some((keyword) => lowered.includes(keyword));
}

// Python tuple comparison of (class, hasDecimals, value).
function outranks(candidate, best) {
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== best[index]) return candidate[index] > best[index];
  }
  return false;
}

/** Returns { amount, detail }. amount is null when nothing convincing is found. */
export function findAmount(text) {
  if (!text) return { amount: null, detail: "empty OCR text" };

  // [class, hasDecimals, value] — compared left to right, so class dominates
  // and magnitude only ever breaks a tie between otherwise identical signals.
  let best = null;
  let bestLine = "";
  let bestKeyword = null;

  // Distinct values accepted per class, so we can tell afterwards whether the
  // winner beat a genuine rival of equal standing or stood alone.
  const valuesByClass = new Map();

  let pending = null; // label carried down from a label-only line
  let gapLines = 0;

  for (const rawLine of text.split(LINE_BREAK)) {
    const line = scrub(rawLine);
    if (!line.trim()) continue; // blank lines neither carry nor break a pending label

    const occurrences = labelOccurrences(line);
    const numbers = [...line.matchAll(NUMBER_PATTERN)];
    const unitHit = firstMatch(lowerSameLength(line), CURRENCY_UNIT_KEYWORDS);

    if (numbers.length === 0) {
      if (occurrences.length > 0) {
        // A label with nothing to label: hold it for the next number line.
        //
        // TODO(deferred — needs real Vision OCR samples): this
        // replacement mishandles a label-COLUMN above a value-COLUMN,
        // which Vision can emit because it groups lines by GEOMETRY,
        // not semantics:
        //
        //     จำนวนเงิน
        //     ยอดคงเหลือ
        //     1,250.00
        //     45,300.00      -> returns 45,300.00, WRONG
        //
        // Two label-only lines run back to back, so the second REPLACES
        // the first instead of queueing behind it. The surviving carry
        // is NEGATIVE, 1,250.00 consumes it and is demoted to class 0,
        // and 45,300.00 is left UNLABELED (class 1) — which outranks it.
        // Fixing this needs a queue of pending labels paired positionally
        // with the numbers that follow. Every fixture in this project is
        // hand-written and no real OCR output has reached this parser
        // yet, so that pairing rule would be a guess at a distribution
        // we have not measured. Deliberately NOT fixed; it waits for
        // real slips. It is at least not silent: the winner is below
        // POSITIVE and the text mentions a balance, so the balance
        // WARNING below fires on this input.
        pending = pickLabel(occurrences);
        gapLines = 0;
      } else {
        gapLines += 1;
        if (gapLines > MAX_CARRY_GAP_LINES) pending = null;
      }
      continue;
    }

    const carried = pending;
    pending = null; // consumed by this number-bearing line, stale afterwards
    gapLines = 0;

    for (const match of numbers) {
      const integerPart = toAsciiDigits(match[1].replaceAll(",", ""));
      const decimalPart = match[2] === undefined ? null : toAsciiDigits(match[2]);
      const value = Number(integerPart + (decimalPart ? "." + decimalPart : ""));
      if (value <= 0) continue;
      const hasDecimals = decimalPart !== null ? 1 : 0;

      let bound = nearestPrecedingLabel(occurrences, match.index);
      if (bound === null && carried !== null && (hasDecimals || unitHit !== null)) {
        // Carry-over is a weak signal: it may not promote a bare integer
        // (reference/account numbers sit on lines like this too).
        bound = carried;
      }

      let numberClass;
      let keyword;
      if (bound !== null) {
        [numberClass, keyword] = bound;
      } else if (unitHit !== null) {
        [numberClass, keyword] = [CLASS_NEUTRAL, unitHit];
      } else {
        [numberClass, keyword] = [CLASS_UNLABELED, null];
      }

      if (numberClass === CLASS_UNLABELED && !hasDecimals) continue; // account/ref/date noise

      if (!valuesByClass.has(numberClass)) valuesByClass.set(numberClass, new Set());
      valuesByClass.get(numberClass).add(value);

      const candidate = [numberClass, hasDecimals, value];
      if (best === null || outranks(candidate, best)) {
        best = candidate;
        bestLine = rawLine.trim();
        bestKeyword = keyword;
      }
    }
  }

  if (best === null) return { amount: null, detail: "no amount-shaped token in OCR text" };

  const [winningClass, , value] = best;
  let detail = "matched on line: " + [...bestLine].slice(0, 80).join("");
  detail += " [" + CLASS_NAMES[winningClass];
  if (bestKeyword) detail += ": " + bestKeyword;
  detail += "]";

  // A tie the text cannot settle: the winner is not carrying an amount label
  // and at least one other number reached the same class, so only the satang
  // and magnitude tiebreaks separated them. This is independent of whether a
  // balance keyword appears — two bare "บาท" lines are just as undecidable.
  const rivals = (valuesByClass.get(winningClass)?.size ?? 0) - 1;

  if (winningClass === CLASS_NEGATIVE) {
    detail += " WARNING: only a balance line was found; this is probably not the transfer amount";
  } else if (winningClass < CLASS_POSITIVE && hasBalanceKeyword(text)) {
    detail +=
      " WARNING: this slip mentions a balance but the chosen number carries no" +
      " amount label; it may be the balance";
  } else if (winningClass < CLASS_POSITIVE && rivals > 0) {
    detail +=
      " WARNING: ambiguous — " + (rivals + 1) + " numbers share the same weak signal" +
      " (" + CLASS_NAMES[winningClass] + ") and nothing in the text says which one" +
      " is the transfer amount";
  } else if (winningClass === CLASS_UNLABELED) {
    detail += " (no amount keyword nearby)";
  }
  return { amount: value, detail };
}
