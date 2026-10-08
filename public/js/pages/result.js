// Port of templates/result.html — the verdict the SERVER recorded for one
// upload, read back through the same scope-checked endpoint as the detail page.

import { getJson } from "../api.js";
import { formatThb, sourceLabel, VERDICT_UI } from "../copy.js";
import { h, keyValueList, memberHref, queryParam, showStubBanner } from "../dom.js";
import { loadInto } from "../error-view.js";

const main = document.getElementById("main");
const id = queryParam("id");
const member = queryParam("member");

loadInto(main, async () => {
  const { expense, view, using_stub_ocr: usingStubOcr } = await getJson(
    memberHref("/api/expenses/" + encodeURIComponent(id), member),
  );
  showStubBanner(usingStubOcr);
  const ui = VERDICT_UI[expense.verdict];

  const details = h(
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
  );

  main.replaceChildren(
    h(
      "div",
      { class: "verdict tone-" + ui.tone, role: "status" },
      h("span", { class: "verdict-icon", "aria-hidden": "true" }, ui.icon),
      h("div", {}, h("h1", {}, ui.headline), h("p", {}, ui.message)),
    ),
    details,
    h(
      "div",
      { class: "btn-pair" },
      h("a", { class: "btn btn-primary", href: "/upload" }, "ส่งสลิปอีกใบ"),
      h("a", { class: "btn btn-secondary", href: memberHref("/my", expense.member_name) }, "ดูรายการของฉัน"),
    ),
  );
});
