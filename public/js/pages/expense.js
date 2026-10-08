// Port of templates/expense_detail.html.

import { getJson } from "../api.js";
import { flagLabels, formatDt, formatThb, sourceLabel, VERDICT_UI } from "../copy.js";
import { h, keyValueList, memberHref, queryParam } from "../dom.js";
import { loadInto } from "../error-view.js";

const main = document.getElementById("main");
const id = window.location.pathname.split("/").pop();
const member = queryParam("member");

loadInto(main, async () => {
  const { expense: row } = await getJson(memberHref("/api/expenses/" + encodeURIComponent(id), member));
  document.title = "รายการ #" + row.id + " — Pegasus";

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
        ["ยอดที่อ่านได้", formatThb(row.extracted_amount) + " ฿", "mono"],
        ["ผลตรวจ", VERDICT_UI[row.verdict].label],
        ["อ่านจาก", sourceLabel(row.extraction_source)],
        row.note && ["บันทึก", row.note],
      ]),
      row.flagged === 1 &&
        h("p", { class: "notice notice-flag" }, "ติดธง: " + flagLabels(row.flag_reason).join(", ")),
    ),
    h(
      "p",
      { class: "mt small" },
      h("a", { class: "muted", href: memberHref("/my", row.member_name) }, "กลับไปรายการของฉัน"),
    ),
  );
});
