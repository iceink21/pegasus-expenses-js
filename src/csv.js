// CSV export with the dialect of Python's csv.writer defaults: comma, minimal
// quoting, CRLF line ends, and a UTF-8 BOM so Excel reads Thai correctly.

export const CSV_COLUMNS = Object.freeze([
  "id",
  "created_at",
  "member_name",
  "category",
  "note",
  "claimed_amount",
  "extracted_amount",
  "extraction_source",
  "verdict",
  "flagged",
  "flag_reason",
  "image_sha256",
  "duplicate_of_id",
  "evidence_backend",
  "evidence_ref",
  "evidence_url",
  "member_id",
  "review_status",
  "evidence_folder",
  "approved_amount",
  "reviewed_by",
  "reviewed_at",
  "review_note",
]);

const NEEDS_QUOTING = /[",\r\n]/;

// Free-text columns a member (or OCR/LLM output) controls. A spreadsheet runs
// a cell starting with = + - @ (or tab / CR) as a formula, so those cells get
// a leading single quote (OWASP CSV injection). Numeric columns are left
// alone: a negative number must stay a number.
export const TEXT_COLUMNS = Object.freeze(
  new Set([
    "member_name",
    "category",
    "note",
    "extraction_detail",
    "flag_reason",
    "review_note",
    "reviewed_by",
  ]),
);
const FORMULA_START = /^[=+\-@\t\r]/;

/** Neutralise a text cell that a spreadsheet would evaluate as a formula. */
export function neutraliseFormula(value) {
  if (typeof value !== "string" || !FORMULA_START.test(value)) return value;
  return "'" + value;
}

export function csvField(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return NEEDS_QUOTING.test(text) ? "\"" + text.replaceAll("\"", "\"\"") + "\"" : text;
}

export function toCsv(rows) {
  const lines = [
    CSV_COLUMNS,
    ...rows.map((row) =>
      CSV_COLUMNS.map((column) => (TEXT_COLUMNS.has(column) ? neutraliseFormula(row[column]) : row[column])),
    ),
  ];
  return "﻿" + lines.map((line) => line.map(csvField).join(",") + "\r\n").join("");
}
