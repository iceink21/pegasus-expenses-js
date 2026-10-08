// Port of templates/error.html: status, Thai message, raw detail code, and a
// way back. Pages render it in place when an API call fails.

import { errorMessage } from "./copy.js";
import { h } from "./dom.js";

export function renderError(container, status, detail) {
  container.replaceChildren(
    h(
      "div",
      { class: "error-view" },
      h("p", { class: "error-code" }, String(status)),
      h("h1", {}, errorMessage(status, detail)),
      h("p", { class: "mono" }, detail ?? ""),
      h("a", { class: "btn btn-primary", href: "/upload" }, "กลับหน้าส่งสลิป"),
    ),
  );
}

/** Run a page loader; any failure replaces `container` with the error view. */
export async function loadInto(container, loader) {
  try {
    await loader();
  } catch (error) {
    renderError(container, error.status ?? 500, error.detail ?? "network_error");
  }
}
