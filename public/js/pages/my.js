// Port of templates/my.html. A member sees their own recent submissions: the
// list is scoped server-side by the member id in their session, and carries
// no verdict. An admin can look up any member by typed name and sees the
// verdict label too.

import { getJson } from "../api.js";
import { formatDt, formatThb, VERDICT_UI } from "../copy.js";
import { h, memberHref, queryParam } from "../dom.js";
import { loadInto } from "../error-view.js";

const results = document.getElementById("results");
const lookupForm = document.getElementById("member-lookup");
const subtitle = document.getElementById("member-subtitle");

function expenseCard(row, admin) {
  return h(
    "a",
    { class: "card", href: "/expenses/" + row.id },
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
        admin && h("p", { class: "xsmall" }, VERDICT_UI[row.verdict].label),
      ),
    ),
  );
}

loadInto(results, async () => {
  const data = await getJson(memberHref("/api/my", queryParam("member")));
  const admin = data.detail_level === "admin";

  if (admin) {
    const input = document.getElementById("member");
    input.value = data.query ?? "";
    document.getElementById("member-names").replaceChildren(
      ...data.member_names.map((name) => h("option", { value: name })),
    );
    lookupForm.hidden = false;
    if (data.query && !data.member) {
      results.replaceChildren(h("p", { class: "small muted" }, "ไม่พบสมาชิกชื่อ " + data.query));
      return;
    }
  } else {
    subtitle.textContent = "ของ " + data.member.name;
    subtitle.hidden = false;
  }

  if (data.member && data.rows.length === 0) {
    results.replaceChildren(h("p", { class: "small muted" }, "ยังไม่มีรายการของ " + data.member.name));
    return;
  }
  results.replaceChildren(h("div", { class: "card-list" }, data.rows.map((row) => expenseCard(row, admin))));
});
