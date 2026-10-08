// Port of templates/expense_detail.html. Members see what they submitted;
// the verdict, extracted amount and flags are admin-only and are not in a
// member's API response at all.

import { getJson } from "../api.js";
import { flagLabels, formatDt, formatThb, sourceLabel, VERDICT_UI } from "../copy.js";
import { h, keyValueList } from "../dom.js";
import { loadInto } from "../error-view.js";

const main = document.getElementById("main");
const id = window.location.pathname.split("/").pop();

loadInto(main, async () => {
  const { expense: row, detail_level: level } = await getJson("/api/expenses/" + encodeURIComponent(id));
  document.title = "รายการ #" + row.id + " — Pegasus";
  const admin = level === "admin";

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
        admin && ["ผลตรวจ", VERDICT_UI[row.verdict].label],
        admin && ["อ่านจาก", sourceLabel(row.extraction_source)],
        row.note && ["บันทึก", row.note],
      ]),
      admin &&
        row.flagged === 1 &&
        h("p", { class: "notice notice-flag" }, "ติดธง: " + flagLabels(row.flag_reason).join(", ")),
    ),
    h("p", { class: "mt small" }, h("a", { class: "muted", href: "/my" }, "กลับไปรายการของฉัน")),
  );
});
