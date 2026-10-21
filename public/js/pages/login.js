// One login for members and admins: username + password (or the one-time
// setup code from the team lead). The server answers with where to go next —
// the change-password page when the account must set a new password.

import { postForm } from "../api.js";
import { errorMessage } from "../copy.js";

const form = document.getElementById("login-form");
const errorBox = document.getElementById("form-error");
const button = form.querySelector("button[type=submit]");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  button.disabled = true;
  try {
    const { location } = await postForm(form.getAttribute("action"), new URLSearchParams(new FormData(form)));
    window.location.assign(location);
  } catch (error) {
    errorBox.textContent = errorMessage(error.status, error.detail);
    errorBox.hidden = false;
    form.querySelector("#password").select();
  } finally {
    button.disabled = false;
  }
});
