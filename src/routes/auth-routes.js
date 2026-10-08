// Team passcode + admin password login.
//
// The team login also takes a typed name. The passcode is checked first, so a
// wrong passcode reveals nothing about names; only then is the name validated
// and resolved to a member (created when new) whose id goes into the session.

import express from "express";

import { AuditAction, writeAudit } from "../audit.js";
import { clientIp, verifySecret } from "../auth.js";
import { HttpError } from "../http-error.js";
import { parseMemberName, resolveOrCreateMember } from "../members.js";
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
    withMember: true,
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
    withMember: false,
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
      const ip = clientIp(req, settings);
      const userAgent = (req.get("user-agent") ?? "").slice(0, 200);
      // DECISION POINT: every outcome is audited here, before any response.
      const audit = (outcome, actorName, extra = {}) =>
        writeAudit(db, {
          actorKind: "anonymous",
          actorName,
          action: outcome === "success" ? login.success : login.failure,
          subjectType: "session",
          subjectId: extra.memberId ?? null,
          outcome,
          detail: { user_agent: userAgent, ...extra.detail },
          clientIp: ip,
        });

      if (!ok) {
        audit("failure", "-");
        res.status(401).json({ detail: login.failureDetail });
        return;
      }

      let member = null;
      if (login.withMember) {
        let name;
        try {
          name = parseMemberName(req.body?.member_name ?? "");
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          audit("failure", "-", { detail: { reason: error.detail } });
          throw error;
        }
        member = resolveOrCreateMember(db, name, {
          actorKind: "member",
          actorName: name,
          clientIp: ip,
          source: "login",
        });
        audit("success", member.name, {
          memberId: member.id,
          detail: { member_id: member.id, member_created: member.created },
        });
      } else {
        audit("success", "-");
      }

      setSessionCookie(
        res,
        settings,
        issueSession(settings, { ...login.session, memberId: member ? member.id : null }),
      );
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
