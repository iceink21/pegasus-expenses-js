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
]);

const NEEDS_QUOTING = /[",\r\n]/;

export function csvField(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return NEEDS_QUOTING.test(text) ? "\"" + text.replaceAll("\"", "\"\"") + "\"" : text;
}

export function toCsv(rows) {
  const lines = [CSV_COLUMNS, ...rows.map((row) => CSV_COLUMNS.map((column) => row[column]))];
  return "﻿" + lines.map((line) => line.map(csvField).join(",") + "\r\n").join("");
}
