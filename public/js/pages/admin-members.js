// Members admin: create accounts, issue setup codes, unlock, disable/enable,
// change role, rename, change username (e.g. a migrated member<id>). A setup
// code is shown once, from the response that created it, and never fetched
// again (the server cannot: it keeps only a hash).

import { getJson, postJson } from "../api.js";
import { errorMessage, formatDt } from "../copy.js";
import { h } from "../dom.js";
import { loadInto } from "../error-view.js";

const container = document.getElementById("members");
const errorBox = document.getElementById("form-error");
const createForm = document.getElementById("create-form");
const createButton = document.getElementById("create-button");
const codeCard = document.getElementById("setup-code");

const ROLE_LABEL = { member: "สมาชิก", admin: "ผู้ดูแล" };

function showError(error) {
  errorBox.textContent = errorMessage(error.status, error.detail);
  errorBox.hidden = false;
  errorBox.scrollIntoView({ block: "nearest" });
}

function showSetupCode(member, code, expiresAt) {
  document.getElementById("setup-code-who").textContent = member.name + " (" + member.username + ")";
  document.getElementById("setup-code-value").textContent = code;
  document.getElementById("setup-code-expiry").textContent = formatDt(expiresAt);
  codeCard.hidden = false;
  codeCard.scrollIntoView({ block: "nearest" });
}

function hideSetupCode() {
  document.getElementById("setup-code-value").textContent = "";
  codeCard.hidden = true;
}

document.getElementById("setup-code-hide").addEventListener("click", hideSetupCode);
document.getElementById("setup-code-copy").addEventListener("click", async (event) => {
  const value = document.getElementById("setup-code-value").textContent;
  try {
    await navigator.clipboard.writeText(value);
    event.target.textContent = "คัดลอกแล้ว";
  } catch {
    event.target.textContent = "คัดลอกไม่ได้ เลือกข้อความเอง";
  }
});

function statusBadges(member) {
  const badges = [];
  if (member.disabled) badges.push(["ปิดใช้งาน", "error"]);
  if (member.locked) badges.push(["ถูกล็อกถึง " + formatDt(member.locked_until), "warn"]);
  if (member.setup_code_active) badges.push(["รอใช้รหัสตั้งค่า", "info"]);
  else if (member.needs_setup) badges.push(["ยังไม่มีรหัสผ่าน", "warn"]);
  if (badges.length === 0) badges.push(["ใช้งานได้", "ok"]);
  return badges.map(([label, tone]) => h("span", { class: "badge badge-" + tone }, label));
}

async function act(path, body, confirmText) {
  if (confirmText && !window.confirm(confirmText)) return null;
  errorBox.hidden = true;
  try {
    return await postJson(path, body ?? {});
  } catch (error) {
    showError(error);
    return null;
  }
}

function actionButtons(member, selfId) {
  const base = "/api/admin/members/" + encodeURIComponent(member.id);
  const button = (label, tone = "secondary") =>
    h("button", { type: "button", class: "btn btn-" + tone + " btn-small" }, label);
  const buttons = [];

  const reset = button("ออกรหัสตั้งค่า");
  reset.addEventListener("click", async () => {
    const warning = member.needs_setup
      ? null
      : "ออกรหัสตั้งค่าใหม่ให้ " + member.name + "? รหัสผ่านเดิมจะใช้ไม่ได้ และทุกอุปกรณ์จะถูกออกจากระบบ";
    const result = await act(base + "/setup-code", {}, warning);
    if (result) {
      showSetupCode(result.member, result.setup_code, result.setup_code_expires_at);
      if (member.id !== selfId) render();
    }
  });
  buttons.push(reset);

  if (member.locked || member.failed_logins > 0) {
    const unlock = button("ปลดล็อก");
    unlock.addEventListener("click", async () => {
      if (await act(base + "/unlock")) render();
    });
    buttons.push(unlock);
  }

  if (member.id !== selfId) {
    const toggle = button(member.disabled ? "เปิดใช้งาน" : "ปิดใช้งาน", member.disabled ? "secondary" : "danger");
    toggle.addEventListener("click", async () => {
      const path = base + (member.disabled ? "/enable" : "/disable");
      const text = member.disabled ? null : "ปิดใช้งานบัญชี " + member.name + "? รายการเดิมยังอยู่ แต่เข้าสู่ระบบไม่ได้";
      if (await act(path, {}, text)) render();
    });
    buttons.push(toggle);
  }

  const nextRole = member.role === "admin" ? "member" : "admin";
  const role = button(nextRole === "admin" ? "ตั้งเป็นผู้ดูแล" : "ลดเป็นสมาชิก");
  role.addEventListener("click", async () => {
    const text = "เปลี่ยน " + member.name + " เป็น" + ROLE_LABEL[nextRole] + "? บัญชีนี้จะต้องเข้าสู่ระบบใหม่";
    if (await act(base + "/role", { role: nextRole }, text)) {
      if (member.id === selfId) window.location.assign("/login");
      else render();
    }
  });
  buttons.push(role);

  const login = button("เปลี่ยนชื่อผู้ใช้");
  login.addEventListener("click", async () => {
    const username = window.prompt("ชื่อผู้ใช้ใหม่ของ " + member.name + " (a–z, 0–9, . _ - 3–32 ตัว)", member.username);
    if (username === null || username.trim() === "" || username.trim().toLowerCase() === member.username) return;
    const text = "เปลี่ยนชื่อผู้ใช้เป็น " + username.trim().toLowerCase() + "? บัญชีนี้จะต้องเข้าสู่ระบบใหม่";
    if (await act(base + "/username", { username }, text)) {
      if (member.id === selfId) window.location.assign("/login");
      else render();
    }
  });
  buttons.push(login);

  const rename = button("เปลี่ยนชื่อ");
  rename.addEventListener("click", async () => {
    const name = window.prompt("ชื่อที่แสดงใหม่ของ " + member.name, member.name);
    if (name === null || name.trim() === "" || name === member.name) return;
    if (await act(base + "/name", { name })) render();
  });
  buttons.push(rename);

  return h("div", { class: "actions" }, buttons);
}

function memberRow(member, selfId) {
  return h(
    "tr",
    {},
    h("td", { class: "nowrap" }, member.name, member.id === selfId ? h("span", { class: "xsmall muted" }, " (คุณ)") : null),
    h("td", { class: "mono nowrap" }, member.username),
    h("td", { class: "nowrap" }, ROLE_LABEL[member.role] ?? member.role),
    h("td", {}, h("div", { class: "actions" }, statusBadges(member))),
    h("td", { class: "nowrap xsmall muted" }, formatDt(member.password_changed_at)),
    h("td", {}, actionButtons(member, selfId)),
  );
}

async function render() {
  await loadInto(container, async () => {
    const data = await getJson("/api/admin/members");
    container.replaceChildren(
      h(
        "div",
        { class: "card table-card" },
        h(
          "table",
          { class: "table" },
          h(
            "thead",
            {},
            h("tr", {}, ["ชื่อ", "ชื่อผู้ใช้", "บทบาท", "สถานะ", "เปลี่ยนรหัสล่าสุด", "จัดการ"].map((name) => h("th", {}, name))),
          ),
          h("tbody", {}, data.members.map((member) => memberRow(member, data.self_id))),
        ),
      ),
    );
  });
}

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  createButton.disabled = true;
  try {
    const fields = new FormData(createForm);
    const result = await postJson("/api/admin/members", {
      name: fields.get("name"),
      username: fields.get("username"),
      role: fields.get("role"),
    });
    createForm.reset();
    showSetupCode(result.member, result.setup_code, result.setup_code_expires_at);
    render();
  } catch (error) {
    showError(error);
  } finally {
    createButton.disabled = false;
  }
});

render();
