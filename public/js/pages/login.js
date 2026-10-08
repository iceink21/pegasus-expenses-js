// Team and admin login share this script; the form's action names the endpoint.
// The team form also carries the typed member name; the admin form has none.

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
    const nameInput = form.querySelector("#member_name");
    if (nameInput && String(error.detail).startsWith("member_name")) nameInput.select();
    else form.querySelector("input[type=password]").select();
  } finally {
    button.disabled = false;
  }
});
