// Port of templates/result.html, read back through the scope-checked
// /api/expenses/:id. A member gets the same neutral confirmation for every
// upload (the server sends them no verdict to show); an admin gets the
// verdict the server recorded.

import { getJson } from "../api.js";
import { formatDt, formatThb, sourceLabel, SUBMITTED_UI, VERDICT_UI } from "../copy.js";
import { h, keyValueList, queryParam, showStubBanner } from "../dom.js";
import { loadInto } from "../error-view.js";

const main = document.getElementById("main");
const id = queryParam("id");

function banner(ui) {
  return h(
    "div",
    { class: "verdict tone-" + ui.tone, role: "status" },
    h("span", { class: "verdict-icon", "aria-hidden": "true" }, ui.icon),
    h("div", {}, h("h1", {}, ui.headline), h("p", {}, ui.message)),
  );
}

function buttons() {
  return h(
    "div",
    { class: "btn-pair" },
    h("a", { class: "btn btn-primary", href: "/upload" }, "ส่งสลิปอีกใบ"),
    h("a", { class: "btn btn-secondary", href: "/my" }, "ดูรายการของฉัน"),
  );
}

function memberReceipt(expense) {
  return [
    banner(SUBMITTED_UI),
    h(
      "div",
      { class: "card mt" },
      h("h2", { class: "section-title" }, "รายละเอียดที่ส่ง"),
      keyValueList([
        ["เลขอ้างอิง", "#" + expense.id, "mono"],
        ["ผู้ส่ง", expense.member_name],
        ["หมวด", expense.category],
        ["ยอดที่กรอก", formatThb(expense.claimed_amount) + " ฿", "mono"],
        expense.note && ["บันทึก", expense.note],
        ["เวลาที่ส่ง", formatDt(expense.created_at)],
      ]),
    ),
    buttons(),
  ];
}

function adminVerdict(expense, view) {
  const ui = VERDICT_UI[expense.verdict];
  return [
    banner(ui),
    h(
      "div",
      { class: "card mt" },
      h("h2", { class: "section-title" }, "รายละเอียดรายการ"),
      keyValueList([
        ["เลขที่รายการ", "#" + expense.id, "mono"],
        ["ผู้จ่าย", expense.member_name],
        ["หมวด", expense.category],
        ["ยอดที่กรอก", formatThb(expense.claimed_amount) + " ฿", "mono"],
        ["ยอดที่ระบบอ่านได้", formatThb(expense.extracted_amount) + " ฿", "mono"],
        view.difference !== null && ["ส่วนต่าง", formatThb(view.difference) + " ฿", "mono"],
        ["เกณฑ์ยอมรับ", "± " + formatThb(view.tolerance) + " ฿", "mono"],
        ["อ่านจาก", sourceLabel(expense.extraction_source)],
      ]),
      view.is_duplicate &&
        h(
          "p",
          { class: "notice notice-dup" },
          "รูปนี้เคยถูกส่งมาแล้วในรายการ #" + expense.duplicate_of_id +
            " ระบบติดธงว่าเป็นสลิปซ้ำเพื่อให้หัวหน้าทีมตรวจ",
        ),
    ),
    buttons(),
  ];
}

loadInto(main, async () => {
  const data = await getJson("/api/expenses/" + encodeURIComponent(id));
  if (data.detail_level === "admin") {
    showStubBanner(data.using_stub_ocr);
    main.replaceChildren(...adminVerdict(data.expense, data.view));
    return;
  }
  main.replaceChildren(...memberReceipt(data.expense));
});
