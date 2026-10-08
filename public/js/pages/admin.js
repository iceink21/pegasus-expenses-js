// Port of templates/admin.html — totals, every expense, and provider status.

import { getJson } from "../api.js";
import { flagLabels, formatDt, formatThb, VERDICT_UI } from "../copy.js";
import { h, keyValueList } from "../dom.js";
import { loadInto } from "../error-view.js";

const container = document.getElementById("dashboard");

const COLUMNS = ["#", "วันที่", "ผู้จ่าย", "หมวด", "กรอก", "อ่านได้", "ผล", "ธง"];
const NUMERIC_COLUMNS = new Set(["กรอก", "อ่านได้"]);

function expenseRow(row) {
  return h(
    "tr",
    {},
    h("td", { class: "mono muted" }, row.id),
    h("td", { class: "nowrap" }, formatDt(row.created_at)),
    h("td", { class: "nowrap" }, row.member_name),
    h("td", { class: "nowrap" }, row.category),
    h("td", { class: "mono num" }, formatThb(row.claimed_amount)),
    h("td", { class: "mono num" }, formatThb(row.extracted_amount)),
    h("td", { class: "nowrap" }, VERDICT_UI[row.verdict].label),
    h("td", { class: "flag" }, flagLabels(row.flag_reason).join(", ")),
  );
}

loadInto(container, async () => {
  const data = await getJson("/api/admin/dashboard");
  const stat = (label, value, extraClass = "") =>
    h("div", { class: "card" }, h("p", { class: "stat-label" }, label), h("p", { class: "stat-value " + extraClass }, value));

  container.replaceChildren(
    h(
      "div",
      { class: "stat-grid" },
      stat("ยอดรวมทั้งทีม", formatThb(data.grand_total) + " ฿"),
      stat("รายการติดธง", String(data.flagged_count), "flag"),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", { class: "section-title" }, "สมาชิกและยอดรายคน"),
      keyValueList(
        data.totals.map((total) => [
          h("span", {}, total.member_name + " ", h("span", { class: "xsmall muted" }, "(" + total.n + " รายการ)")),
          formatThb(total.total) + " ฿",
          "mono",
        ]),
      ),
    ),
    h("h2", { class: "section-title mt" }, "รายการทั้งหมด"),
    h(
      "div",
      { class: "card table-card" },
      h(
        "table",
        { class: "table" },
        h("thead", {}, h("tr", {}, COLUMNS.map((name) => h("th", { class: NUMERIC_COLUMNS.has(name) ? "num" : null }, name)))),
        h("tbody", {}, data.rows.map(expenseRow)),
      ),
    ),
    h(
      "div",
      { class: "card mt" },
      h("h2", { class: "section-title" }, "สถานะระบบ"),
      keyValueList([
        ["ตัวอ่านยอด (OCR)", data.providers.ocr, "mono"],
        ["ที่เก็บหลักฐาน", data.providers.storage, "mono"],
        ["ตรวจสลิปกับธนาคาร", data.providers.slip_verifier, "mono"],
      ]),
      h("ul", { class: "provider-notes mono" }, data.providers.notes.map((note) => h("li", {}, note))),
    ),
  );
});
