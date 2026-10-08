// Port of templates/my.html — a member's own recent expenses. The member is a
// client-asserted label (see README §3), not an identity.

import { getJson } from "../api.js";
import { formatDt, formatThb, VERDICT_UI } from "../copy.js";
import { h, memberHref, queryParam } from "../dom.js";
import { loadInto } from "../error-view.js";

const results = document.getElementById("results");
const select = document.getElementById("member");
const member = queryParam("member");

function expenseCard(row) {
  return h(
    "a",
    { class: "card", href: memberHref("/expenses/" + row.id, member) },
    h(
      "div",
      { class: "card-row" },
      h(
        "div",
        {},
        h("p", {}, h("strong", {}, row.category)),
        h("p", { class: "xsmall muted" }, formatDt(row.created_at) + " · #" + row.id),
        row.note && h("p", { class: "small muted" }, row.note),
      ),
      h(
        "div",
        { class: "end" },
        h("p", { class: "mono" }, formatThb(row.claimed_amount) + " ฿"),
        h("p", { class: "xsmall" }, VERDICT_UI[row.verdict].label),
      ),
    ),
  );
}

loadInto(results, async () => {
  const data = await getJson(memberHref("/api/my", member));
  select.append(
    ...data.members.map((name) => h("option", { value: name, selected: name === data.member }, name)),
  );
  if (data.member && data.rows.length === 0) {
    results.replaceChildren(h("p", { class: "small muted" }, "ยังไม่มีรายการของ " + data.member));
    return;
  }
  results.replaceChildren(h("div", { class: "card-list" }, data.rows.map(expenseCard)));
});
