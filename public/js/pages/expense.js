// Port of templates/expense_detail.html. Members see what they submitted;
// the verdict, extracted amount, flags and the review are admin-only and are
// not in a member's API response at all.
//
// Admin + pending row: a review form. The approved amount starts as the
// claimed amount; the admin corrects it if the slip says otherwise. The
// server keeps the claim and the verdict as they were either way.

import { ApiError, getJson, postJson } from "../api.js";
import { errorMessage, flagLabels, folderLabel, formatDt, formatThb, reviewUi, sourceLabel, VERDICT_UI } from "../copy.js";
import { h, keyValueList, showStubBanner } from "../dom.js";
import { loadInto } from "../error-view.js";

const main = document.getElementById("main");
const id = window.location.pathname.split("/").pop();

function reviewForm(row, onReviewed) {
  const errorBox = h("p", { class: "notice notice-error", role: "alert", hidden: true });
  const amount = h("input", {
    class: "input mono",
    id: "approved_amount",
    name: "approved_amount",
    inputmode: "decimal",
    autocomplete: "off",
    required: true,
    value: formatThb(row.claimed_amount),
  });
  const note = h("textarea", { class: "input", id: "review_note", name: "note", maxlength: 500, rows: 3 });
  const approve = h("button", { class: "btn btn-primary", type: "submit", value: "approve" }, "อนุมัติ");
  const reject = h("button", { class: "btn btn-danger", type: "button", value: "reject" }, "ไม่อนุมัติ");

  const send = async (decision) => {
    errorBox.hidden = true;
    approve.disabled = true;
    reject.disabled = true;
    try {
      const payload = { decision, note: note.value };
      if (decision === "approve") payload.approved_amount = amount.value;
      const result = await postJson("/api/admin/expenses/" + encodeURIComponent(row.id) + "/review", payload);
      onReviewed(result);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      errorBox.textContent = errorMessage(status, error.detail);
      errorBox.hidden = false;
      approve.disabled = false;
      reject.disabled = false;
    }
  };

  const form = h(
    "form",
    { class: "card review-form", novalidate: true },
    h("h2", { class: "section-title" }, "ตรวจรายการนี้"),
    errorBox,
    h(
      "div",
      { class: "field" },
      h("label", { for: "approved_amount" }, "ยอดที่อนุมัติ (บาท)"),
      amount,
      h("p", { class: "hint" }, "เริ่มจากยอดที่กรอก " + formatThb(row.claimed_amount) + " ฿ แก้ได้ถ้ายอดจริงต่างไป"),
    ),
    h(
      "div",
      { class: "field" },
      h("label", { for: "review_note" }, "หมายเหตุ (ไม่บังคับ)"),
      note,
    ),
    h("div", { class: "btn-pair" }, approve, reject),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    send("approve");
  });
  reject.addEventListener("click", () => send("reject"));
  return form;
}

function reviewResult(row) {
  const ui = reviewUi(row.review_status);
  return h(
    "div",
    { class: "card mt" },
    h("h2", { class: "section-title" }, "ผลการตรวจ"),
    keyValueList([
      ["สถานะ", h("span", { class: "badge badge-" + ui.tone }, ui.label)],
      row.review_status === "approved" && ["ยอดที่อนุมัติ", formatThb(row.approved_amount) + " ฿", "mono"],
      row.reviewed_by && ["ผู้ตรวจ", row.reviewed_by],
      row.reviewed_at && ["เวลาตรวจ", formatDt(row.reviewed_at)],
      row.review_note && ["หมายเหตุผู้ตรวจ", row.review_note],
      ["โฟลเดอร์หลักฐาน", folderLabel(row.evidence_folder)],
    ]),
  );
}

function render(row, admin) {
  document.title = "รายการ #" + row.id + " — Pegasus";
  const reviewSection = admin
    ? row.review_status === "pending"
      ? reviewForm(row, (result) => render(result.expense, true))
      : reviewResult(row)
    : null;

  main.replaceChildren(
    h("h1", { class: "page-title" }, "รายการ #" + row.id),
    h(
      "div",
      { class: "card mt" },
      keyValueList([
        ["วันที่", formatDt(row.created_at)],
        ["ผู้จ่าย", row.member_name],
        ["หมวด", row.category],
        ["ยอดที่กรอก", formatThb(row.claimed_amount) + " ฿", "mono"],
        admin && ["ยอดที่อ่านได้", formatThb(row.extracted_amount) + " ฿", "mono"],
        admin && ["ผลตรวจ", VERDICT_UI[row.verdict]?.label ?? row.verdict],
        admin && ["อ่านจาก", sourceLabel(row.extraction_source)],
        admin && /^https:\/\//i.test(row.evidence_url ?? "") && ["หลักฐาน", h("a", { href: row.evidence_url, target: "_blank", rel: "noopener noreferrer" }, "เปิดไฟล์")],
        row.note && ["บันทึก", row.note],
      ]),
      admin &&
        row.flagged === 1 &&
        h("p", { class: "notice notice-flag" }, "ติดธง: " + flagLabels(row.flag_reason).join(", ")),
    ),
    reviewSection,
    h("p", { class: "mt small" }, h("a", { class: "muted", href: admin ? "/admin" : "/my" }, admin ? "กลับไปมุมมองหัวหน้าทีม" : "กลับไปรายการของฉัน")),
  );
}

loadInto(main, async () => {
  const body = await getJson("/api/expenses/" + encodeURIComponent(id));
  const admin = body.detail_level === "admin";
  if (admin) showStubBanner(Boolean(body.using_stub_ocr));
  render(body.expense, admin);
});
