// Change password. Right after logging in with a setup code (or as the
// bootstrap admin) this is the only page the session may use; the "current
// password" box then takes the setup code.

import { getJson, postJson } from "../api.js";
import { errorMessage } from "../copy.js";
import { h } from "../dom.js";
import { loadInto } from "../error-view.js";

const main = document.getElementById("main");
const form = document.getElementById("password-form");
const errorBox = document.getElementById("form-error");
const button = document.getElementById("submit-button");

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

loadInto(main, async () => {
  const account = await getJson("/api/account");
  // Lets the browser's password manager file the new password under the right name.
  document.getElementById("username").value = account.username;
  const identity = document.getElementById("account-identity");
  identity.replaceChildren("บัญชี ", h("strong", {}, account.name), " (", h("span", { class: "mono" }, account.username), ")");
  identity.hidden = false;
  if (account.using_setup_code) {
    document.getElementById("current-label").textContent = "รหัสตั้งค่าที่ได้จากหัวหน้าทีม";
    document.getElementById("current_password").setAttribute("autocomplete", "one-time-code");
  }
  if (account.must_change_password) {
    document.getElementById("lede").textContent =
      "ก่อนใช้งาน ต้องตั้งรหัสผ่านของคุณเองก่อน อย่างน้อย 10 ตัวอักษร ใช้ประโยคยาว ๆ ที่จำง่ายได้";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const current = form.elements.current_password.value;
  const next = form.elements.new_password.value;
  if (next !== document.getElementById("confirm_password").value) {
    showError(errorMessage(400, "password_confirm_mismatch"));
    return;
  }
  button.disabled = true;
  try {
    const { location } = await postJson("/api/account/password", { current_password: current, new_password: next });
    window.location.assign(location);
  } catch (error) {
    showError(errorMessage(error.status, error.detail));
    button.disabled = false;
  }
});
