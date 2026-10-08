// Port of tests/test_extraction.py — the extraction stages and the pure verdict
// function. Every amount-text expectation is identical to the Python suite.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loadSettings } from "../src/config.js";
import { decideVerdict, Verdict } from "../src/decision.js";
import {
  CLASS_NEGATIVE,
  CLASS_POSITIVE,
  findAmount,
  lowerSameLength,
  MAX_CARRY_GAP_LINES,
  pickLabel,
} from "../src/extraction/amount-text.js";
import { ExtractionResult, Source } from "../src/extraction/base.js";
import { ExtractionPipeline } from "../src/extraction/pipeline.js";
import { amountFromEmvPayload, parseEmvTlv } from "../src/extraction/qr.js";
import { StubOCRExtractor } from "../src/extraction/stub.js";
import { emv, testEnv } from "./helpers.js";

describe("EMVCo QR payloads", () => {
  test("parse_emv_tlv reads top-level tags", () => {
    const parsed = parseEmvTlv(emv(["00", "01"], ["54", "123.45"], ["58", "TH"]));
    assert.equal(parsed["00"], "01");
    assert.equal(parsed["54"], "123.45");
    assert.equal(parsed["58"], "TH");
  });

  test("bill QR with tag 54 yields amount", () => {
    assert.equal(amountFromEmvPayload(emv(["00", "01"], ["54", "250.00"], ["58", "TH"])), 250.0);
  });

  test("slip QR without tag 54 yields nothing", () => {
    // A post-payment slip QR carries a bank code + ref, never the amount.
    const payload = emv(["00", "01"], ["01", "12"], ["58", "TH"], ["62", "0104ABC1"]);
    assert.equal(amountFromEmvPayload(payload), null);
  });

  test("non-EMV payload is ignored", () => {
    assert.equal(amountFromEmvPayload("https://example.com/receipt/abc123"), null);
  });
});

describe("findAmount", () => {
  for (const [text, expected] of [
    ["จำนวนเงิน 1,250.00 บาท", 1250.0],
    ["ยอดเงิน\n980.50", 980.5],
    ["Amount THB 45.00", 45.0],
    ["โอนเงินสำเร็จ\n2,000.00 บาท", 2000.0],
  ]) {
    test("reads Thai slip line: " + JSON.stringify(text), () => {
      assert.equal(findAmount(text).amount, expected);
    });
  }

  const BALANCE_LINE = "ยอดคงเหลือ 45,300.00 บาท";
  const TRANSFER_LINE = "จำนวนเงิน 1,250.00 บาท";

  test("prefers transfer over balance listed first", () => {
    // The regression: the balance is the LARGER number, so magnitude must not win.
    const { amount, detail } = findAmount(BALANCE_LINE + "\n" + TRANSFER_LINE);
    assert.equal(amount, 1250.0);
    assert.ok(detail.includes("จำนวนเงิน"));
  });

  test("prefers transfer when balance comes second", () => {
    assert.equal(findAmount(TRANSFER_LINE + "\n" + BALANCE_LINE).amount, 1250.0);
  });

  test("balance-only slip returns the balance but flags it", () => {
    // Documented choice: return the number and warn, rather than UNREADABLE.
    const { amount, detail } = findAmount(BALANCE_LINE);
    assert.equal(amount, 45300.0);
    assert.ok(detail.includes("WARNING"));
  });

  test("balance keyword beats a positive substring on the same line", () => {
    const text = "ยอดเงินคงเหลือ 99,999.00 บาท\nจำนวนเงิน 320.00 บาท";
    assert.equal(findAmount(text).amount, 320.0);
  });

  test("English balance line is demoted too", () => {
    const text = "Available Balance 45,300.00 THB\nAmount 1,250.00 THB";
    assert.equal(findAmount(text).amount, 1250.0);
  });

  test("currency unit alone does not outrank a real amount keyword", () => {
    const text = "คงเหลือ 8,000.00 บาท\n1,111.00 บาท\nยอดชำระ 250.00 บาท";
    assert.equal(findAmount(text).amount, 250.0);
  });

  test("multiple positive keywords agree", () => {
    assert.equal(findAmount("ยอดรวม 1,250.00 บาท\nจำนวนเงิน 1,250.00 บาท").amount, 1250.0);
  });

  test("full slip shape with ref, date, balance and amount", () => {
    const text =
      "โอนเงินสำเร็จ\n" +
      "12/07/2026 09:41\n" +
      "เลขที่อ้างอิง 015432119\n" +
      "จำนวนเงิน 1,250.00 บาท\n" +
      "ค่าธรรมเนียม 0.00 บาท\n" +
      "ยอดคงเหลือ 45,300.00 บาท";
    assert.equal(findAmount(text).amount, 1250.0);
  });

  // --- Stacked layout: label on its own line above its number. --------------
  const STACKED_TRANSFER_FIRST = "จำนวนเงิน\n1,250.00 บาท\nยอดคงเหลือ\n45,300.00 บาท";
  const STACKED_BALANCE_FIRST = "ยอดคงเหลือ\n45,300.00 บาท\nจำนวนเงิน\n1,250.00 บาท";

  test("stacked Thai, transfer label first", () => {
    const { amount, detail } = findAmount(STACKED_TRANSFER_FIRST);
    assert.equal(amount, 1250.0);
    assert.ok(detail.includes("จำนวนเงิน"));
  });

  test("stacked Thai, balance label first", () => {
    assert.equal(findAmount(STACKED_BALANCE_FIRST).amount, 1250.0);
  });

  test("stacked without currency unit on the number lines", () => {
    assert.equal(findAmount("จำนวนเงิน\n1,250.00\nยอดคงเหลือ\n45,300.00").amount, 1250.0);
  });

  test("stacked English amount and balance", () => {
    assert.equal(findAmount("Amount\n1,250.00 THB\nAvailable Balance\n45,300.00 THB").amount, 1250.0);
  });

  test("stacked English, balance first", () => {
    assert.equal(findAmount("Available Balance\n45,300.00 THB\nAmount\n1,250.00 THB").amount, 1250.0);
  });

  test("both labels on one line bind to the nearest preceding label", () => {
    const { amount, detail } = findAmount("จำนวนเงิน 1,250.00 บาท ยอดคงเหลือ 45,300.00 บาท");
    assert.equal(amount, 1250.0);
    assert.ok(detail.includes("จำนวนเงิน"));
  });

  test("stacked selection follows the label, not the smaller number", () => {
    assert.equal(findAmount("จำนวนเงิน\n45,300.00 บาท\nยอดคงเหลือ\n1,250.00 บาท").amount, 45300.0);
  });

  test("same-line selection follows the label, not the smaller number", () => {
    assert.equal(findAmount("จำนวนเงิน 45,300.00 บาท\nยอดคงเหลือ 1,250.00 บาท").amount, 45300.0);
  });

  test("stacked balance-only slip still warns", () => {
    const { amount, detail } = findAmount("ยอดคงเหลือ\n45,300.00 บาท");
    assert.equal(amount, 45300.0);
    assert.ok(detail.includes("WARNING"));
  });

  test("unlabeled number on a slip mentioning a balance is flagged", () => {
    assert.ok(findAmount("ยอดคงเหลือ\n45,300.00 บาท\n1,250.00 บาท").detail.includes("WARNING"));
  });

  test("carry-over does not leak past unrelated lines", () => {
    const text =
      "จำนวนเงิน\nทำรายการสำเร็จ\nธนาคารไทยพาณิชย์\nสาขาลาดพร้าว\nเลขที่อ้างอิง 015432119";
    assert.equal(findAmount(text).amount, null);
  });

  test("carry-over is replaced by a later label line", () => {
    const { amount, detail } = findAmount("จำนวนเงิน\nยอดคงเหลือ\n45,300.00 บาท");
    assert.equal(amount, 45300.0);
    assert.ok(detail.includes("WARNING"));
  });

  // --- Targeted tests for the individual defenses of the per-number classifier.

  test("number touching the end of its label is still bound", () => {
    // Pins `end <= position` in nearestPrecedingLabel.
    const { amount, detail } = findAmount("ยอดชำระ1,250.00\n45,300.00 บาท");
    assert.equal(amount, 1250.0);
    assert.ok(detail.includes("amount label"));
    assert.ok(detail.includes("ยอดชำระ"));
  });

  test("currency unit outranks a number with no label at all", () => {
    // Pins the NEUTRAL > UNLABELED class ordering.
    const { amount, detail } = findAmount("1,250.00\n45,300.00 บาท");
    assert.equal(amount, 45300.0);
    assert.ok(detail.includes("currency unit only"));
  });

  test("carry-over is consumed by the first number line", () => {
    const { amount, detail } = findAmount("จำนวนเงิน\n1,250.00 บาท\n45,300.00 บาท");
    assert.equal(amount, 1250.0);
    assert.ok(detail.includes("amount label"));
  });

  test("carry-over cannot promote a bare integer", () => {
    assert.equal(findAmount("จำนวนเงิน\n015432119").amount, null);
  });

  test("carry-over is replaced by the nearer label, not queued behind it", () => {
    const { detail } = findAmount("จำนวนเงิน\nยอดคงเหลือ\n45,300.00 บาท");
    assert.ok(detail.includes("balance label"));
    assert.ok(detail.includes("ยอดคงเหลือ"));
  });

  test("carry-over survives exactly MAX_CARRY_GAP_LINES", () => {
    assert.equal(MAX_CARRY_GAP_LINES, 2);
    const { amount, detail } = findAmount(
      "จำนวนเงิน\nทำรายการสำเร็จ\nธนาคารไทยพาณิชย์\n1,250.00 บาท",
    );
    assert.equal(amount, 1250.0);
    assert.ok(detail.includes("amount label"));
  });

  test("carry-over expires on the line after MAX_CARRY_GAP_LINES", () => {
    const { amount, detail } = findAmount(
      "จำนวนเงิน\nทำรายการสำเร็จ\nธนาคารไทยพาณิชย์\nสาขาลาดพร้าว\n1,250.00 บาท",
    );
    assert.equal(amount, 1250.0); // still read, but no longer as a labelled amount
    assert.ok(detail.includes("currency unit only"));
    assert.ok(!detail.includes("amount label"));
  });

  test("latest-ending label wins over a positive substring", () => {
    const { detail } = findAmount("ยอดเงินคงเหลือ 99,999.00 บาท");
    assert.ok(detail.includes("balance label"));
    assert.ok(!detail.includes("amount label"));
    assert.ok(detail.includes("WARNING"));
  });

  test("pickLabel prefers the balance class when two labels end at one offset", () => {
    assert.deepEqual(
      pickLabel([
        [10, CLASS_POSITIVE, "ยอดเงิน"],
        [10, CLASS_NEGATIVE, "คงเหลือ"],
      ]),
      [CLASS_NEGATIVE, "คงเหลือ"],
    );
  });

  test("pickLabel names the longer keyword when two end at one offset", () => {
    const occurrences = [
      [17, CLASS_NEGATIVE, "balance"],
      [17, CLASS_NEGATIVE, "available balance"],
    ];
    assert.deepEqual(pickLabel(occurrences), [CLASS_NEGATIVE, "available balance"]);
    assert.deepEqual(pickLabel([...occurrences].reverse()), [CLASS_NEGATIVE, "available balance"]);
  });

  test("the reported keyword is the full English balance label", () => {
    assert.ok(findAmount("Available Balance 45,300.00 THB").detail.includes("available balance"));
  });

  test("lowerSameLength folds case without ever changing length", () => {
    const line = "AMOUNT İ 1,250.00";
    const lowered = lowerSameLength(line);
    assert.equal(lowered.length, line.length);
    assert.ok(lowered.startsWith("amount"));
  });

  test("two equally plausible numbers are flagged even without a balance word", () => {
    const { amount, detail } = findAmount("1,250.00 บาท\n45,300.00 บาท");
    assert.equal(amount, 45300.0);
    assert.ok(detail.includes("WARNING"));
    assert.ok(detail.includes("ambiguous"));
  });

  test("label column above value column is wrong but never silent", () => {
    // KNOWN, DEFERRED limitation — see the TODO in findAmount.
    const { amount, detail } = findAmount("จำนวนเงิน\nยอดคงเหลือ\n1,250.00\n45,300.00");
    assert.equal(amount, 45300.0); // wrong answer, documented
    assert.ok(detail.includes("WARNING"));
  });

  test("full stacked slip with ref, date, fee and balance", () => {
    const text =
      "โอนเงินสำเร็จ\n12/07/2026 09:41\nเลขที่อ้างอิง 015432119\nจำนวนเงิน\n1,250.00 บาท\n" +
      "ค่าธรรมเนียม\n0.00 บาท\nยอดคงเหลือ\n45,300.00 บาท";
    assert.equal(findAmount(text).amount, 1250.0);
  });

  test("rejects reference numbers and dates", () => {
    const text = "เลขที่อ้างอิง 015432119\nวันที่ 12/07/2026 เวลา 09:41\nบัญชี 1234567890";
    assert.equal(findAmount(text).amount, null);
  });

  test("empty text", () => {
    assert.equal(findAmount("").amount, null);
  });
});

describe("stub OCR", () => {
  test("marker amount", async () => {
    const result = await new StubOCRExtractor().extract(Buffer.from("PEGASUS_STUB_AMOUNT=77.25"));
    assert.equal(result.amount, 77.25);
    assert.equal(result.source, Source.OCR);
  });

  test("marker unreadable", async () => {
    const result = await new StubOCRExtractor().extract(Buffer.from("PEGASUS_STUB_UNREADABLE"));
    assert.equal(result.amount, null);
    assert.equal(result.found, false);
  });

  test("deterministic for binary input", async () => {
    const blob = Buffer.alloc(1024, 0).map((_, index) => index % 256);
    const first = await new StubOCRExtractor().extract(blob);
    const second = await new StubOCRExtractor().extract(blob);
    assert.equal(first.amount, second.amount);
    assert.ok(first.notes.join(" ").includes("synthetic"));
  });
});

describe("pipeline", () => {
  test("prefers QR when it finds an amount", async () => {
    const fakeQr = {
      name: "FakeQR",
      extract: async () => new ExtractionResult({ amount: 500.0, source: Source.QR, detail: "tag 54" }),
    };
    const pipeline = new ExtractionPipeline({ qrStage: fakeQr, ocrStage: new StubOCRExtractor() });
    const result = await pipeline.run(Buffer.from("PEGASUS_STUB_AMOUNT=1.00"));
    assert.equal(result.amount, 500.0);
    assert.equal(result.source, Source.QR);
  });

  test("falls through to OCR when QR misses", async () => {
    const missingQr = {
      name: "MissingQR",
      extract: async () => ExtractionResult.empty("no QR payload decoded"),
    };
    const pipeline = new ExtractionPipeline({ qrStage: missingQr, ocrStage: new StubOCRExtractor() });
    const result = await pipeline.run(Buffer.from("PEGASUS_STUB_AMOUNT=1.00"));
    assert.equal(result.amount, 1.0);
    assert.equal(result.source, Source.OCR);
  });

  test("survives a raising QR stage", async () => {
    const explodingQr = {
      name: "ExplodingQR",
      extract: async () => {
        throw new Error("libzbar missing");
      },
    };
    const pipeline = new ExtractionPipeline({ qrStage: explodingQr, ocrStage: new StubOCRExtractor() });
    assert.equal((await pipeline.run(Buffer.from("PEGASUS_STUB_AMOUNT=9.00"))).amount, 9.0);
  });
});

test("verdict tolerance is configurable", () => {
  const settings = loadSettings(testEnv());
  assert.equal(decideVerdict(100.0, 100.0, settings).verdict, Verdict.MATCH);
  assert.equal(decideVerdict(100.0, 100.9, settings).verdict, Verdict.MATCH);
  assert.equal(decideVerdict(100.0, 105.0, settings).verdict, Verdict.MISMATCH);
  assert.equal(decideVerdict(100.0, null, settings).verdict, Verdict.UNREADABLE);
  // Percentage branch dominates on large claims: 0.5% of 100000 = 500
  assert.equal(decideVerdict(100000.0, 99600.0, settings).verdict, Verdict.MATCH);
});
