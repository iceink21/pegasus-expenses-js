// Deterministic local OCR stub — runs with zero credentials.
//
// NEVER silently substituted for the real thing: providers.js logs the
// selection at startup, and REQUIRE_REAL_PROVIDERS=1 makes startup fail rather
// than pick this class.
//
// Behaviour, in order:
//   1. If the uploaded bytes contain the marker PEGASUS_STUB_UNREADABLE,
//      return no amount (exercises the UNREADABLE path).
//   2. If they contain PEGASUS_STUB_AMOUNT=<number>, return that amount (lets
//      the tests and curl recipes drive MATCH and MISMATCH deterministically).
//   3. If the bytes decode as text, run the same amount parser the real OCR uses.
//   4. Otherwise derive a stable pseudo-amount from the image hash —
//      deterministic per image, but deliberately unrelated to the real slip,
//      which is exactly what a stub should look like.

import crypto from "node:crypto";

import { pyRound2, toAsciiDigits } from "../../shared/numbers.js";
import { findAmount } from "./amount-text.js";
import { ExtractionResult, Source } from "./base.js";

export const MARKER_UNREADABLE = "PEGASUS_STUB_UNREADABLE";
const MARKER_AMOUNT = /PEGASUS_STUB_AMOUNT=(\p{Nd}+(?:\.\p{Nd}{1,2})?)/u;
const SCAN_BYTES = 8192;

// bytes.decode("utf-8", errors="ignore"): invalid sequences vanish rather than
// becoming U+FFFD, and a leading BOM is kept as a character.
function decodeIgnoringErrors(bytes) {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).replaceAll("�", "");
}

export class StubOCRExtractor {
  name = "StubOCRExtractor";

  async extract(imageBytes) {
    const head = decodeIgnoringErrors(imageBytes.subarray(0, SCAN_BYTES));
    const headPreview = [...head].slice(0, 200).join("");

    if (head.includes(MARKER_UNREADABLE)) {
      return ExtractionResult.empty("stub marker: unreadable", ["StubOCRExtractor"]);
    }

    const marker = head.match(MARKER_AMOUNT);
    if (marker) {
      return new ExtractionResult({
        amount: Number(toAsciiDigits(marker[1])),
        source: Source.OCR,
        detail: "stub marker amount",
        rawText: headPreview,
        notes: ["StubOCRExtractor"],
      });
    }

    const { amount, detail } = findAmount(head);
    if (amount !== null) {
      return new ExtractionResult({
        amount,
        source: Source.OCR,
        detail: "stub text parse: " + detail,
        rawText: headPreview,
        notes: ["StubOCRExtractor"],
      });
    }

    const digest = crypto.createHash("sha256").update(imageBytes).digest("hex");
    const pseudo = (parseInt(digest.slice(0, 8), 16) % 100000) / 100;
    if (pseudo <= 0) {
      return ExtractionResult.empty("stub produced no amount", ["StubOCRExtractor"]);
    }
    return new ExtractionResult({
      amount: pyRound2(pseudo),
      source: Source.OCR,
      detail: "stub pseudo-amount derived from image hash (NOT a real reading)",
      rawText: "",
      notes: ["StubOCRExtractor", "value is synthetic"],
    });
  }
}
