// Port of templates/audit.html — the most recent audit rows, newest first.

import { getJson } from "../api.js";
import { formatDt } from "../copy.js";
import { h } from "../dom.js";
import { loadInto } from "../error-view.js";

const container = document.getElementById("audit");
const COLUMNS = ["เวลา", "ผู้กระทำ", "การกระทำ", "เป้าหมาย", "ผล", "รายละเอียด"];

function auditRow(row) {
  return h(
    "tr",
    {},
    h("td", { class: "nowrap" }, formatDt(row.ts)),
    h("td", { class: "nowrap" }, row.actor_name + " ", h("span", { class: "xsmall muted" }, "(" + row.actor_kind + ")")),
    h("td", { class: "mono nowrap" }, row.action),
    h("td", { class: "mono nowrap" }, row.subject_type + (row.subject_id ? ":" + row.subject_id : "")),
    h("td", { class: "mono nowrap" }, row.outcome),
    h("td", { class: "detail" }, row.detail),
  );
}

loadInto(container, async () => {
  const { rows } = await getJson("/api/admin/audit");
  container.replaceChildren(
    h(
      "div",
      { class: "card table-card" },
      h(
        "table",
        { class: "table" },
        h("thead", {}, h("tr", {}, COLUMNS.map((name) => h("th", {}, name)))),
        h("tbody", {}, rows.map(auditRow)),
      ),
    ),
  );
});
