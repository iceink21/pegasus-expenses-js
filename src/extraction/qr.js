// QR stage — EMVCo / PromptPay TLV parsing, tag 54 = transaction amount.
//
// READ THIS BEFORE "FIXING" ANYTHING HERE
// ---------------------------------------
// The QR printed on a payment *slip* (the screenshot you get AFTER paying) does
// NOT carry the amount. It carries a bank code plus a transaction reference
// used by the bank's own slip-verification API. Only a *bill* QR — the EMVCo
// payload you scan BEFORE paying — carries the amount, in TLV tag 54, and a
// team member photographing their own receipt almost never has that.
//
// So this stage is a lucky bonus, not the answer. It runs first because when
// it does hit, the amount is exact and free. When it misses (the common case)
// the pipeline falls through to OCR, which is the primary amount source.
//
// Do not promote QR to primary. Do not treat a QR miss as an error.

import { parsePyFloat, toAsciiDigits } from "../../shared/numbers.js";
import { ExtractionResult, Source } from "./base.js";
import { decodeQrPayloads } from "./qr-decode.js";

const EMV_AMOUNT_TAG = "54";
const EMV_PAYLOAD_FORMAT_TAG = "00";
const TWO_DIGITS = /^\p{Nd}{2}$/u;

/**
 * Parse a flat EMVCo TLV string into {tag: value}. Non-recursive by design:
 * tag 54 is always top-level.
 */
export function parseEmvTlv(payload) {
  const result = {};
  let index = 0;
  const length = payload.length;
  while (index + 4 <= length) {
    const tag = payload.slice(index, index + 2);
    const rawLen = payload.slice(index + 2, index + 4);
    if (!TWO_DIGITS.test(tag) || !TWO_DIGITS.test(rawLen)) break;
    const start = index + 4;
    const end = start + Number(toAsciiDigits(rawLen));
    if (end > length) break;
    result[tag] = payload.slice(start, end);
    index = end;
  }
  return result;
}

/** EMVCo payloads begin with tag 00 length 02 and a version like '01'. */
export function looksLikeEmvco(payload) {
  return payload.length >= 6 && payload.startsWith(EMV_PAYLOAD_FORMAT_TAG + "02");
}

export function amountFromEmvPayload(payload) {
  if (!looksLikeEmvco(payload)) return null;
  const raw = parseEmvTlv(payload)[EMV_AMOUNT_TAG];
  // Absent is normal for a post-payment slip QR — bank code + ref only.
  if (!raw) return null;
  const value = parsePyFloat(raw);
  if (value === null) return null;
  return value > 0 ? value : null;
}

export class QRAmountExtractor {
  name = "QRAmountExtractor";

  async extract(imageBytes) {
    const { payloads, notes } = await decodeQrPayloads(imageBytes);
    if (payloads.length === 0) return ExtractionResult.empty("no QR payload decoded", notes);

    for (const payload of payloads) {
      const amount = amountFromEmvPayload(payload);
      if (amount !== null) {
        return new ExtractionResult({
          amount,
          source: Source.QR,
          detail: "EMVCo tag 54",
          rawText: payload,
          notes,
        });
      }
    }

    return ExtractionResult.empty("QR without amount", [
      ...notes,
      "QR decoded but carries no tag 54 — expected for a post-payment slip QR",
    ]);
  }
}
