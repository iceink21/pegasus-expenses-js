// Upload form: the browser sends the image and the claimed amount only. The
// verdict comes back from the server; this page never computes one.

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
  fillSelect(document.getElementById("member_name"), config.members);
  fillSelect(document.getElementById("category"), config.categories);
  showStubBanner(config.using_stub_ocr);
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
