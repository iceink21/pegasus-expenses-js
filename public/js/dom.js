// DOM building without HTML strings: every value lands via textContent or
// setAttribute, so data from the server can never be parsed as markup.

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

/** A <dl class="kv"> from [term, value, valueClass?] rows; null rows are skipped. */
export function keyValueList(rows) {
  return h(
    "dl",
    { class: "kv" },
    rows
      .filter(Boolean)
      .map(([term, value, valueClass]) => h("div", {}, h("dt", {}, term), h("dd", { class: valueClass }, value))),
  );
}

export function showStubBanner(visible) {
  const banner = document.getElementById("stub-banner");
  if (banner) banner.hidden = !visible;
}

export function queryParam(name) {
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

/** Link to a member-scoped page, with the member label as a query parameter. */
export function memberHref(path, member) {
  return member ? path + "?" + new URLSearchParams({ member }) : path;
}
