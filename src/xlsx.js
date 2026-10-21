// Excel export, built on demand from the database — no file is kept.
//
// Sheet "สรุปรายคน": one row per member from the shared totals aggregate
// (src/totals.js), then a team-total row with SUM formulas (their cached
// results are the SQL grand totals, so a viewer that does not recalculate
// still shows the right numbers).
// Sheet "รายการ": every expense, including the admin's approved amount and the
// review trail, with a hyperlink to the evidence when it has a URL.
//
// Cell values are written as typed values (numbers, plain strings, hyperlink
// objects); a string that starts with "=" stays a string, never a formula.

import ExcelJS from "exceljs";

import { formatDt } from "../public/js/copy.js";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const SUMMARY_SHEET = "สรุปรายคน";
export const ITEMS_SHEET = "รายการ";

const FONT_NAME = "Tahoma"; // ships with Windows and macOS and covers Thai
const MONEY_FORMAT = "#,##0.00";
const SAFE_LINK = /^https?:\/\//i;

const SUMMARY_COLUMNS = [
  { header: "สมาชิก", key: "member_name", width: 22 },
  { header: "จำนวนรายการ", key: "n", width: 12 },
  { header: "ยอดที่กรอก (ไม่รวมที่ไม่อนุมัติ)", key: "claimed_total", width: 18, money: true },
  { header: "ยอดยืนยันแล้ว", key: "verified_total", width: 16, money: true },
  { header: "ยอดรอตรวจ", key: "pending_total", width: 16, money: true },
  { header: "ยอดไม่อนุมัติ", key: "rejected_total", width: 16, money: true },
  { header: "จำนวนรอตรวจ", key: "pending_count", width: 12 },
  { header: "อัปโหลดล่าสุด", key: "last_upload", width: 18 },
];

const ITEM_COLUMNS = [
  { header: "#", key: "id", width: 7 },
  { header: "วันที่", key: "created_at", width: 17 },
  { header: "ผู้จ่าย", key: "member_name", width: 18 },
  { header: "หมวด", key: "category", width: 18 },
  { header: "บันทึก", key: "note", width: 28 },
  { header: "ยอดที่กรอก", key: "claimed_amount", width: 14, money: true },
  { header: "ยอดที่อ่านได้", key: "extracted_amount", width: 14, money: true },
  { header: "ผลตรวจ", key: "verdict", width: 12 },
  { header: "ธง", key: "flag_reason", width: 22 },
  { header: "สถานะตรวจ", key: "review_status", width: 12 },
  { header: "ยอดที่อนุมัติ", key: "approved_amount", width: 14, money: true },
  { header: "โฟลเดอร์หลักฐาน", key: "evidence_folder", width: 15 },
  { header: "ผู้ตรวจ", key: "reviewed_by", width: 10 },
  { header: "เวลาตรวจ", key: "reviewed_at", width: 17 },
  { header: "หมายเหตุผู้ตรวจ", key: "review_note", width: 28 },
  { header: "หลักฐาน", key: "evidence", width: 40 },
];

function setUpSheet(sheet, columns) {
  sheet.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
  columns.forEach((column, index) => {
    if (column.money) sheet.getColumn(index + 1).numFmt = MONEY_FORMAT;
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function applyFonts(sheet) {
  sheet.eachRow((row, rowNumber) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      const font = { name: FONT_NAME, size: 10, bold: rowNumber === 1 || cell.font?.bold === true };
      if (cell.hyperlink) Object.assign(font, { color: { argb: "FF1D4ED8" }, underline: true });
      cell.font = font;
    });
  });
}

const dt = (value) => (value ? formatDt(value) : null);

function evidenceCell(row) {
  if (row.evidence_url && SAFE_LINK.test(String(row.evidence_url))) {
    return { text: String(row.evidence_url), hyperlink: String(row.evidence_url) };
  }
  return row.evidence_ref ? String(row.evidence_ref) : null;
}

/** Build the workbook and return it as a Buffer. */
export async function buildTotalsWorkbook({ totals, expenses, generatedAt = new Date() }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Pegasus expenses";
  workbook.created = generatedAt;

  // --- summary --------------------------------------------------------
  const summary = workbook.addWorksheet(SUMMARY_SHEET);
  setUpSheet(summary, SUMMARY_COLUMNS);
  for (const member of totals.members) {
    summary.addRow({ ...member, last_upload: dt(member.last_upload) });
  }
  const firstData = 2;
  const lastData = totals.members.length + 1;
  const grand = totals.grand;
  const totalRow = summary.addRow({ member_name: "รวมทั้งทีม", last_upload: dt(grand.last_upload) });
  SUMMARY_COLUMNS.forEach((column, index) => {
    if (!["n", "claimed_total", "verified_total", "pending_total", "rejected_total", "pending_count"].includes(column.key)) {
      return;
    }
    const cell = totalRow.getCell(index + 1);
    const letter = summary.getColumn(index + 1).letter;
    cell.value =
      lastData >= firstData
        ? { formula: "SUM(" + letter + firstData + ":" + letter + lastData + ")", result: grand[column.key] }
        : grand[column.key];
  });
  totalRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true };
    cell.border = { top: { style: "thin" } };
  });

  // --- every expense ----------------------------------------------------
  const items = workbook.addWorksheet(ITEMS_SHEET);
  setUpSheet(items, ITEM_COLUMNS);
  for (const row of expenses) {
    items.addRow({
      ...row,
      created_at: dt(row.created_at),
      reviewed_at: dt(row.reviewed_at),
      evidence: evidenceCell(row),
    });
  }

  applyFonts(summary);
  applyFonts(items);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
