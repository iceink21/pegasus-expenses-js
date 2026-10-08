// Upload form: the browser sends the image and the claimed amount only. The
// server decides the verdict and never tells a member what it was; this page
// just moves on to the confirmation. A member submits as the name they logged
// in with; an admin types the name to submit for.

import { getJson, postForm } from "../api.js";
import { errorMessage } from "../copy.js";
import { h, showStubBanner } from "../dom.js";
import { loadInto } from "../error-view.js";

const main = document.getElementById("main");
const form = document.getElementById("upload-form");
const errorBox = document.getElementById("form-error");
const button = document.getElementById("submit-button");

function fillSelect(select, values) {
  select.replaceChildren(...values.map((value) => h("option", { value }, value)));
}

loadInto(main, async () => {
  const config = await getJson("/api/upload-form");
  fillSelect(document.getElementById("category"), config.categories);
  if (config.member) {
    const identity = document.getElementById("member-identity");
    identity.replaceChildren(
      "ส่งในนาม ",
      h("strong", {}, config.member.name),
      " · ",
      h("a", { href: "/logout" }, "ไม่ใช่คุณ? ออกจากระบบ"),
    );
    identity.hidden = false;
  } else {
    const input = document.getElementById("member_name");
    document.getElementById("member-names").replaceChildren(
      ...(config.member_names ?? []).map((name) => h("option", { value: name })),
    );
    input.disabled = false;
    input.required = true;
    document.getElementById("member-field").hidden = false;
  }
  showStubBanner(Boolean(config.using_stub_ocr));
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = "กำลังส่ง…";
  try {
    const result = await postForm("/upload", new FormData(form));
    window.location.assign(result.result_url);
  } catch (error) {
    errorBox.textContent = errorMessage(error.status, error.detail);
    errorBox.hidden = false;
    errorBox.scrollIntoView({ block: "nearest" });
    button.disabled = false;
    button.textContent = "ส่งสลิป";
  }
});
