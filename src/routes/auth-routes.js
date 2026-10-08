// Team passcode + admin password login.

import express from "express";

import { AuditAction, writeAudit } from "../audit.js";
import { clientIp, verifySecret } from "../auth.js";
import { clearSessionCookie, issueSession, readSession, setSessionCookie } from "../session.js";
import { sendPage, wantsJson } from "./http.js";

const LOGINS = [
  {
    path: "/login",
    page: "login.html",
    field: "passcode",
    secret: (settings) => settings.teamPasscode,
    success: AuditAction.LOGIN_TEAM_SUCCESS,
    failure: AuditAction.LOGIN_TEAM_FAILURE,
    failureDetail: "bad_passcode",
    session: { team: true, admin: false },
    next: "/upload",
  },
  {
    path: "/admin/login",
    page: "admin-login.html",
    field: "password",
    secret: (settings) => settings.adminPassword,
    success: AuditAction.LOGIN_ADMIN_SUCCESS,
    failure: AuditAction.LOGIN_ADMIN_FAILURE,
    failureDetail: "bad_admin_password",
    session: { team: true, admin: true },
    next: "/admin",
  },
];

export function createAuthRouter(ctx) {
  const { db, settings } = ctx;
  const router = express.Router();
  const form = express.urlencoded({ extended: false });

  router.get("/", (req, res) => {
    const session = readSession(req, settings);
    res.redirect(303, session.team || session.admin ? "/upload" : "/login");
  });

  for (const login of LOGINS) {
    router.get(login.path, (req, res) => sendPage(res, login.page));

    router.post(login.path, form, (req, res) => {
      const candidate = typeof req.body?.[login.field] === "string" ? req.body[login.field] : "";
      const ok = verifySecret(candidate, login.secret(settings));

      // DECISION POINT: the outcome is audited here, for success and failure
      // alike, before any response is built.
      writeAudit(db, {
        actorKind: "anonymous",
        actorName: "-",
        action: ok ? login.success : login.failure,
        subjectType: "session",
        outcome: ok ? "success" : "failure",
        detail: { user_agent: (req.get("user-agent") ?? "").slice(0, 200) },
        clientIp: clientIp(req, settings),
      });

      if (!ok) {
        res.status(401).json({ detail: login.failureDetail });
        return;
      }
      setSessionCookie(res, settings, issueSession(settings, login.session));
      // The page script asks for JSON so it can navigate itself; any other
      // client gets the same 303 the Python app sent.
      if (wantsJson(req)) {
        res.json({ location: login.next });
        return;
      }
      res.redirect(303, login.next);
    });
  }

  router.get("/logout", (req, res) => {
    const session = readSession(req, settings);
    if (Object.keys(session).length > 0) {
      writeAudit(db, {
        actorKind: session.admin ? "admin" : "member",
        actorName: "-",
        action: AuditAction.LOGOUT,
        subjectType: "session",
        outcome: "success",
        clientIp: clientIp(req, settings),
      });
    }
    clearSessionCookie(res);
    res.redirect(303, "/login");
  });

  return router;
}
