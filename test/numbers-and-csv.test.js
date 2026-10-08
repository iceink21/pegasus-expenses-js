// Python-compatibility helpers, UI formatting and the CSV dialect.
// Expected values below were produced by CPython (round, float, format).

import assert from "node:assert/strict";
import { test } from "node:test";

import { flagLabels, formatDt, formatThb } from "../public/js/copy.js";
import { parsePyFloat, parsePyInt, pyRound2, toAsciiDigits } from "../shared/numbers.js";
import { csvField, toCsv } from "../src/csv.js";
import { parseAmount } from "../src/routes/expenses.js";

test("pyRound2 matches Python round(x, 2), ties to even on the exact value", () => {
  for (const [input, expected] of [
    [0.125, 0.12],
    [0.375, 0.38],
    [2.675, 2.67],
    [1.005, 1.0],
    [-0.125, -0.12],
    [270.0, 270.0],
    [1250.5, 1250.5],
  ]) {
    assert.equal(pyRound2(input), expected, String(input));
  }
});

test("parsePyFloat accepts what float() accepts and nothing else", () => {
  assert.equal(parsePyFloat("1250"), 1250);
  assert.equal(parsePyFloat("1_000.5"), 1000.5);
  assert.equal(parsePyFloat(".5"), 0.5);
  assert.equal(parsePyFloat("5."), 5);
  assert.equal(parsePyFloat("1e3"), 1000);
  assert.equal(parsePyFloat("-inf"), -Infinity);
  assert.ok(Number.isNaN(parsePyFloat("nan")));
  assert.equal(parsePyFloat("๑๒๕๐"), 1250);
  for (const bad of ["", "abc", "1.2.3", "0x10", "1__0", "_1", "12a", "1e"]) {
    assert.equal(parsePyFloat(bad), null, bad);
  }
  assert.equal(parsePyInt(" 43200 "), 43200);
  assert.equal(parsePyInt("8MB"), null);
  assert.equal(toAsciiDigits("๑๒:๓๐"), "12:30");
});

test("parseAmount mirrors the Python validation codes", () => {
  assert.equal(parseAmount("1,250.00 ฿"), 1250);
  assert.equal(parseAmount("0.125"), 0.12);
  for (const [raw, code] of [
    ["", "amount_required"],
    ["abc", "amount_not_a_number"],
    ["nan", "amount_not_a_number"],
    ["0", "amount_must_be_positive"],
    ["10000000.01", "amount_out_of_range"],
  ]) {
    assert.throws(() => parseAmount(raw), (error) => error.status === 400 && error.detail === code, raw);
  }
});

test("UI formatting matches the Jinja filters", () => {
  assert.equal(formatThb(1250), "1,250.00");
  assert.equal(formatThb(2.675), "2.67");
  assert.equal(formatThb(1234567.891), "1,234,567.89");
  assert.equal(formatThb(null), "—");
  assert.equal(formatDt("2026-10-08T01:21:01+00:00"), "08/10/2026 01:21");
  assert.equal(formatDt(""), "—");
  assert.deepEqual(flagLabels("amount_mismatch,duplicate_image"), ["ยอดไม่ตรง", "สลิปซ้ำ"]);
});

test("CSV uses minimal quoting, CRLF and a BOM", () => {
  assert.equal(csvField(null), "");
  assert.equal(csvField("a,b"), "\"a,b\"");
  assert.equal(csvField("say \"hi\""), "\"say \"\"hi\"\"\"");
  assert.equal(csvField("ค่าน้ำมัน"), "ค่าน้ำมัน");
  const csv = toCsv([{ id: 1, member_name: "ติ้ว", note: "line1\nline2", flagged: 0 }]);
  assert.ok(csv.startsWith("﻿id,created_at,member_name,"));
  assert.ok(csv.includes("\r\n1,,ติ้ว,,\"line1\nline2\",,,,,0,"));
});
