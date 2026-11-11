// Port of templates/admin.html — totals, every expense, and provider status.
// Totals come from the one server-side aggregate (src/totals.js) that also
// feeds the Excel export, so the page and the file always agree.

import { getJson } from "../api.js";
import { flagLabels, folderLabel, formatDt, formatThb, reviewUi, VERDICT_UI } from "../copy.js";
import { h, keyValueList } from "../dom.js";
import { loadInto } from "../error-view.js";

const container = document.getElementById("dashboard");

const COLUMNS = ["#", "สลิป", "วันที่", "ผู้จ่าย", "หมวด", "กรอก", "อ่านได้", "อนุมัติ", "ผล", "ธง", "สถานะตรวจ", "โฟลเดอร์"];
const NUMERIC_COLUMNS = new Set(["กรอก", "อ่านได้", "อนุมัติ"]);

function reviewBadge(status) {
  const ui = reviewUi(status);
  return h("span", { class: "badge badge-" + ui.tone }, ui.label);
}

function expenseRow(row) {
  return h(
    "tr",
    {},
    h("td", { class: "mono muted" }, h("a", { class: "muted", href: "/expenses/" + encodeURIComponent(row.id) }, row.id)),
    h(
      "td",
      { class: "nowrap" },
      h("a", { href: "/admin/expenses/" + encodeURIComponent(row.id) + "/slip", target: "_blank", rel: "noopener" }, "ดูสลิป"),
    ),
    h("td", { class: "nowrap" }, formatDt(row.created_at)),
    h("td", { class: "nowrap" }, row.member_name),
    h("td", { class: "nowrap" }, row.category),
    h("td", { class: "mono num" }, formatThb(row.claimed_amount)),
    h("td", { class: "mono num" }, formatThb(row.extracted_amount)),
    h("td", { class: "mono num" }, formatThb(row.approved_amount)),
    h("td", { class: "nowrap" }, VERDICT_UI[row.verdict]?.label ?? row.verdict),
    h("td", { class: "flag" }, flagLabels(row.flag_reason).join(", ")),
    h("td", { class: "nowrap" }, reviewBadge(row.review_status)),
    h("td", { class: "nowrap xsmall muted" }, folderLabel(row.evidence_folder)),
  );
}

const FOLDER_CHOICES = ["verified", "needs-review", "rejected"];

// The claims table with its filters; refetches from /api/admin/expenses.
function claimsTable(initialRows) {
  const tbody = h("tbody", {}, initialRows.map(expenseRow));
  const member = h("input", { class: "input", type: "search", name: "member", placeholder: "ชื่อผู้จ่าย", "aria-label": "ชื่อผู้จ่าย" });
  const verdict = h(
    "select",
    { class: "input", name: "verdict", "aria-label": "ผลตรวจ" },
    h("option", { value: "" }, "ทุกผล"),
    FOLDER_CHOICES.map((folder) => h("option", { value: folder }, folderLabel(folder))),
  );
  const form = h("form", { class: "filter-row mt" }, member, verdict, h("button", { class: "btn btn-secondary btn-small", type: "submit" }, "กรอง"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const params = new URLSearchParams();
    if (member.value.trim()) params.set("member", member.value.trim());
    if (verdict.value) params.set("verdict", verdict.value);
    const data = await getJson("/api/admin/expenses" + (params.size ? "?" + params : ""));
    tbody.replaceChildren(...data.rows.map(expenseRow));
  });
  const table = h(
    "div",
    { class: "card table-card" },
    h(
      "table",
      { class: "table" },
      h("thead", {}, h("tr", {}, COLUMNS.map((name) => h("th", { class: NUMERIC_COLUMNS.has(name) ? "num" : null }, name)))),
      tbody,
    ),
  );
  return [form, table];
}

loadInto(container, async () => {
  const data = await getJson("/api/admin/dashboard");
  // The table comes from the slim list endpoint, not the dashboard's full rows.
  const claims = await getJson("/api/admin/expenses");
  const grand = data.grand;
  const stat = (label, value, extraClass = "", sub = null) =>
    h(
      "div",
      { class: "card" },
      h("p", { class: "stat-label" }, label),
      h("p", { class: "stat-value " + extraClass }, value),
      sub && h("p", { class: "stat-sub" }, sub),
    );

  container.replaceChildren(
    h(
      "div",
      { class: "stat-grid" },
      stat("ยอดรวมทั้งทีม", formatThb(grand.claimed_total) + " ฿", "", "ไม่รวมรายการที่ไม่อนุมัติ"),
      stat("ยืนยันแล้ว", formatThb(grand.verified_total) + " ฿", "", "ผ่านอัตโนมัติ + ยอดที่อนุมัติ"),
      stat("รอตรวจ", formatThb(grand.pending_total) + " ฿", "flag", grand.pending_count + " รายการ"),
      stat("ไม่อนุมัติ", formatThb(grand.rejected_total) + " ฿", "", grand.rejected_count + " รายการ"),
      stat("รายการติดธง", String(data.flagged_count), "flag"),
      stat("จำนวนรายการ", String(grand.n)),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", { class: "section-title" }, "สมาชิกและยอดรายคน"),
      keyValueList(
        data.totals.map((total) => [
          h(
            "span",
            {},
            total.member_name + " ",
            h("span", { class: "xsmall muted" }, "(" + total.n + " รายการ)"),
            h(
              "span",
              { class: "member-split" },
              "ยืนยัน " + formatThb(total.verified_total) +
                " · รอตรวจ " + formatThb(total.pending_total) +
                " · ไม่อนุมัติ " + formatThb(total.rejected_total),
            ),
          ),
          formatThb(total.claimed_total) + " ฿",
          "mono",
        ]),
      ),
    ),
    h("h2", { class: "section-title mt" }, "รายการทั้งหมด"),
    ...claimsTable(claims.rows),
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
