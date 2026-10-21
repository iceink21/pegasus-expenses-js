// Thai UI copy + formatting — one module, imported by every page script and by
// the test suite. Port of app/templating.py and the error tables in
// app/main.py, so the softer UNREADABLE wording cannot drift between pages.
// UNREADABLE asks for a clearer photo; it never implies fraud.
//
// VERDICT_UI is admin-only copy: member sessions never receive a verdict, and
// see SUBMITTED_UI after every upload whatever the server decided.

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

export const SUBMITTED_UI = Object.freeze({
  headline: "ส่งหลักฐานเรียบร้อยแล้ว",
  message: "รอผู้ดูแลตรวจสอบ",
  tone: "info",
  icon: "✓",
});

// Evidence review (admin-only, like VERDICT_UI). `tone` maps to .badge-<tone>.
export const REVIEW_UI = Object.freeze({
  verified: { label: "ผ่านอัตโนมัติ", tone: "ok" },
  pending: { label: "รอตรวจ", tone: "warn" },
  approved: { label: "อนุมัติแล้ว", tone: "ok" },
  rejected: { label: "ไม่อนุมัติ", tone: "error" },
});

const FOLDER_LABEL = Object.freeze({
  verified: "Verified",
  "needs-review": "Needs-Review",
  rejected: "Rejected",
  legacy: "เดิม (ก่อนแยกโฟลเดอร์)",
});

export function reviewUi(status) {
  return REVIEW_UI[status] ?? { label: status ?? "—", tone: "info" };
}

export function folderLabel(folder) {
  return FOLDER_LABEL[folder] ?? folder ?? "—";
}

const SOURCE_LABEL = Object.freeze({
  qr: "QR (EMVCo tag 54)",
  ocr: "OCR",
  llm: "AI (LLM)",
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
  409: "รายการนี้ถูกแก้ไปแล้ว",
  423: "บัญชีถูกล็อกชั่วคราว",
  429: "ลองหลายครั้งเกินไป รอสักครู่แล้วลองใหม่",
  404: "ไม่พบหน้าที่ต้องการ",
  413: "ไฟล์ใหญ่เกินไป กรุณาย่อรูปก่อนอัปโหลด",
  422: "กรอกข้อมูลไม่ครบ",
  502: "ระบบเก็บไฟล์ขัดข้อง ลองใหม่อีกครั้ง",
});

const DETAIL_MESSAGES_TH = Object.freeze({
  amount_required: "กรุณากรอกจำนวนเงิน",
  amount_not_a_number: "จำนวนเงินต้องเป็นตัวเลข",
  amount_must_be_positive: "จำนวนเงินต้องมากกว่า 0",
  amount_out_of_range: "จำนวนเงินเกินช่วงที่รับได้",
  member_name_required: "กรุณาพิมพ์ชื่อของคุณ",
  member_name_too_long: "ชื่อยาวเกินไป (ไม่เกิน 60 ตัวอักษร)",
  member_name_invalid: "ชื่อมีอักขระที่ใช้ไม่ได้ กรุณาพิมพ์ใหม่",
  unknown_category: "ไม่พบหมวดค่าใช้จ่ายนี้",
  empty_file: "ไม่พบไฟล์รูปสลิป",
  file_too_large: "ไฟล์ใหญ่เกินไป กรุณาย่อรูปก่อนอัปโหลด",
  not_found: "ไม่พบรายการนี้",
  scope: "รายการนี้เป็นของสมาชิกคนอื่น",
  permission: "บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้",
  bad_credentials: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง",
  account_locked: "บัญชีถูกล็อกชั่วคราวเพราะใส่รหัสผิดหลายครั้ง รอสักครู่หรือติดต่อหัวหน้าทีม",
  account_disabled: "บัญชีนี้ถูกปิดใช้งาน ติดต่อหัวหน้าทีม",
  rate_limited: "ลองเข้าสู่ระบบหลายครั้งเกินไป รอสักครู่แล้วลองใหม่",
  csrf_rejected: "คำขอไม่ได้มาจากหน้าของระบบ กรุณาเปิดหน้าใหม่แล้วลองอีกครั้ง",
  admin_required: "หน้านี้สำหรับผู้ดูแลเท่านั้น",
  password_change_required: "กรุณาตั้งรหัสผ่านใหม่ก่อน",
  password_required: "กรุณากรอกรหัสผ่านใหม่",
  password_too_short: "รหัสผ่านสั้นเกินไป (อย่างน้อย 10 ตัวอักษร)",
  password_too_long: "รหัสผ่านยาวเกินไป (ไม่เกิน 128 ตัวอักษร)",
  password_same_as_username: "รหัสผ่านต้องไม่เหมือนชื่อผู้ใช้",
  password_too_common: "รหัสผ่านนี้คนใช้กันบ่อยเกินไป เลือกอันอื่น",
  password_unchanged: "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม",
  password_confirm_mismatch: "รหัสผ่านใหม่สองช่องไม่ตรงกัน",
  current_password_required: "กรุณากรอกรหัสผ่านปัจจุบัน",
  current_password_wrong: "รหัสผ่านปัจจุบัน (หรือรหัสตั้งค่า) ไม่ถูกต้อง",
  credential_changed: "รหัสผ่านของบัญชีนี้เพิ่งถูกเปลี่ยน กรุณาเข้าสู่ระบบใหม่",
  username_invalid: "ชื่อผู้ใช้ใช้ได้เฉพาะ a–z, 0–9, จุด, ขีด, ขีดล่าง 3–32 ตัว",
  username_taken: "ชื่อผู้ใช้นี้มีคนใช้แล้ว",
  name_taken: "มีสมาชิกชื่อนี้แล้ว",
  invalid_role: "ไม่รู้จักบทบาทนี้",
  last_admin: "ต้องมีผู้ดูแลที่ใช้งานได้อย่างน้อยหนึ่งคน",
  cannot_disable_self: "ปิดใช้งานบัญชีของตัวเองไม่ได้",
  member_not_found: "ไม่พบสมาชิกนี้",
  unknown_member: "ไม่พบสมาชิกที่เลือก",
  invalid_member_id: "เลือกสมาชิกไม่ถูกต้อง",
  not_pending: "รายการนี้ตรวจไปแล้ว รีเฟรชหน้าเพื่อดูผลล่าสุด",
  review_in_progress: "มีคนกำลังตรวจรายการนี้อยู่ ลองใหม่อีกครั้ง",
  invalid_decision: "ไม่รู้จักผลการตรวจนี้",
  invalid_note: "หมายเหตุไม่ถูกต้อง",
  note_too_long: "หมายเหตุยาวเกินไป (ไม่เกิน 500 ตัวอักษร)",
  invalid_body: "ข้อมูลที่ส่งมาไม่ถูกต้อง",
  evidence_move_failed: "ย้ายไฟล์หลักฐานไม่สำเร็จ สถานะยังไม่เปลี่ยน ลองใหม่อีกครั้ง",
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
