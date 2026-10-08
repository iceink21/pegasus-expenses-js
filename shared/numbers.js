// Python-compatible number handling.
//
// The Python original leans on three behaviours JavaScript does not share:
//   * regex `\d` and float()/int() accept every Unicode decimal digit, so a
//     Thai phone keyboard typing ๑,๒๕๐ still parses as 1250;
//   * float() accepts underscores, inf and nan, and rejects partial strings
//     that Number()/parseFloat() would silently accept or truncate;
//   * round(x, 2) rounds the exact binary value half-to-even.
// Each helper below reproduces one of those so the port decides identically.

const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/gu;
const DECIMAL_DIGIT = /^\p{Nd}$/u;

// Unicode lays out every decimal-digit run as ten consecutive code points
// starting at zero, so a digit's value is its offset from the run start.
function digitValue(ch) {
  const codePoint = ch.codePointAt(0);
  let start = codePoint;
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) {
    start -= 1;
  }
  return (codePoint - start) % 10;
}

export function toAsciiDigits(text) {
  return String(text).replace(NON_ASCII_DIGIT, (ch) => String(digitValue(ch)));
}

const PY_FLOAT =
  /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const PY_SPECIAL_FLOAT = /^([+-]?)(inf|infinity|nan)$/i;
const PY_INT = /^[+-]?\d(?:_?\d)*$/;

/** float(raw) as Python parses it; null where Python raises ValueError. */
export function parsePyFloat(raw) {
  const text = toAsciiDigits(raw).trim();
  const special = text.match(PY_SPECIAL_FLOAT);
  if (special) {
    if (special[2].toLowerCase() === "nan") return Number.NaN;
    return special[1] === "-" ? -Infinity : Infinity;
  }
  if (!PY_FLOAT.test(text)) return null;
  return Number(text.replaceAll("_", ""));
}

/** int(raw) as Python parses a base-10 string; null where Python raises. */
export function parsePyInt(raw) {
  const text = toAsciiDigits(raw).trim();
  if (!PY_INT.test(text)) return null;
  return Number(text.replaceAll("_", ""));
}

/**
 * Python's round(value, 2): nearest by the exact binary value, ties to even.
 *
 * toFixed() already rounds by the exact value, but breaks exact ties upward.
 * An exact two-decimal tie must equal (2k+1)/200, and a double can only hold
 * that when it is an odd multiple of 1/8 — so that is the one case handled
 * by hand.
 */
export function pyRound2(value) {
  if (!Number.isFinite(value)) return value;
  if (Number.isInteger(value * 8) && !Number.isInteger(value * 4)) {
    const lower = Math.floor(value * 100);
    return (lower % 2 === 0 ? lower : lower + 1) / 100;
  }
  return Number(value.toFixed(2));
}
