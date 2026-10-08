// Thai UI copy + formatting — one module, imported by every page script and by
// the test suite. Port of app/templating.py and the error tables in
// app/main.py, so the softer UNREADABLE wording cannot drift between pages.
// UNREADABLE asks for a clearer photo; it never implies fraud.

// Served at /shared/numbers.js; the relative path also resolves under Node,
// where the test suite imports this module straight from disk.
import { pyRound2 } from "../../shared/numbers.js";

export const VERDICT_UI = Object.freeze({
  MATCH: {
    label: "ยอดตรงกัน",
    headline: "ยอดตรงกับสลิป",
    message: "ระบบอ่านยอดจากสลิปแล้วตรงกับที่กรอก บันทึกรายการเรียบร้อย",
    tone: "ok",
    icon: "✓",
  },
  MISMATCH: {
    label: "ยอดไม่ตรง",
    headline: "ยอดที่กรอกไม่ตรงกับสลิป",
    message:
      "ระบบบันทึกรายการไว้แล้ว และติดธงให้หัวหน้าทีมตรวจสอบ " +
      "ถ้ากรอกตัวเลขผิด แจ้งหัวหน้าทีมเพื่อแก้ไขได้เลย",
    tone: "warn",
    icon: "!",
  },
  UNREADABLE: {
    label: "อ่านยอดไม่ออก",
    headline: "ยังอ่านยอดจากรูปไม่ได้",
    message:
      "รูปอาจเบลอ มืด หรือถ่ายไม่เต็มสลิป " +
      "รบกวนถ่ายใหม่ให้เห็นบรรทัดจำนวนเงินชัด ๆ แล้วส่งอีกครั้ง " +
      "ระบบยังไม่ถือว่ารายการนี้มีปัญหา",
    tone: "info",
    icon: "?",
  },
});

const SOURCE_LABEL = Object.freeze({
  qr: "QR (EMVCo tag 54)",
  ocr: "OCR",
  none: "ไม่พบยอด",
});

const FLAG_REASON_LABEL = Object.freeze({
  amount_mismatch: "ยอดไม่ตรง",
  duplicate_image: "สลิปซ้ำ",
});

const ERROR_MESSAGES_TH = Object.freeze({
  400: "ข้อมูลที่ส่งมาไม่ถูกต้อง",
  401: "กรุณาเข้าสู่ระบบอีกครั้ง",
  403: "ไม่มีสิทธิ์เข้าถึงรายการนี้",
  404: "ไม่พบหน้าที่ต้องการ",
  413: "ไฟล์ใหญ่เกินไป กรุณาย่อรูปก่อนอัปโหลด",
  422: "กรอกข้อมูลไม่ครบ",
});

const DETAIL_MESSAGES_TH = Object.freeze({
  amount_required: "กรุณากรอกจำนวนเงิน",
  amount_not_a_number: "จำนวนเงินต้องเป็นตัวเลข",
  amount_must_be_positive: "จำนวนเงินต้องมากกว่า 0",
  amount_out_of_range: "จำนวนเงินเกินช่วงที่รับได้",
  unknown_member: "ไม่พบชื่อสมาชิกคนนี้ในทีม",
  unknown_category: "ไม่พบหมวดค่าใช้จ่ายนี้",
  empty_file: "ไม่พบไฟล์รูปสลิป",
  file_too_large: "ไฟล์ใหญ่เกินไป กรุณาย่อรูปก่อนอัปโหลด",
  not_found: "ไม่พบรายการนี้",
  scope: "รายการนี้เป็นของสมาชิกคนอื่น",
  permission: "บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้",
  bad_passcode: "รหัสทีมไม่ถูกต้อง ลองใหม่อีกครั้ง",
  bad_admin_password: "รหัสผู้ดูแลไม่ถูกต้อง",
});

/** Thai message for an API failure: the specific detail first, then the status. */
export function errorMessage(status, detail) {
  return DETAIL_MESSAGES_TH[detail] ?? ERROR_MESSAGES_TH[status] ?? "เกิดข้อผิดพลาด";
}

const THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;

/**
 * Python's format(value, ",.2f"). Rounding goes through pyRound2 because Intl
 * rounds the shortest decimal string (2.675 → 2.68) where Python rounds the
 * exact binary value (2.675 → 2.67).
 */
export function formatThb(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const rounded = pyRound2(number);
  const [whole, fraction] = Math.abs(rounded).toFixed(2).split(".");
  const sign = rounded < 0 || Object.is(rounded, -0) ? "-" : "";
  return sign + whole.replace(THOUSANDS, ",") + "." + fraction;
}

const ISO_PREFIX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/**
 * "%d/%m/%Y %H:%M" of the stored timestamp, exactly as the Python filter did:
 * the clock time as stored (UTC), with no timezone conversion.
 */
export function formatDt(value) {
  if (!value) return "—";
  const parts = String(value).match(ISO_PREFIX);
  if (!parts) return String(value);
  const [, year, month, day, hour, minute] = parts;
  return day + "/" + month + "/" + year + " " + hour + ":" + minute;
}

export function flagLabels(flagReason) {
  if (!flagReason) return [];
  return String(flagReason)
    .split(",")
    .map((part) => FLAG_REASON_LABEL[part] ?? part);
}

export function sourceLabel(source) {
  return SOURCE_LABEL[source] ?? source;
}
