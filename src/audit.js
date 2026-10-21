// Audit log writes.
//
// DESIGN RULE (learned the hard way): the audit row is written *at the point of
// the decision*, inside the same transaction that records the decision — never
// in a wrapper, middleware, or response hook. A short-circuit return (403,
// duplicate, unreadable image, bad password, missing session) cannot skip an
// audit row that is written by the very function that produced the
// short-circuit.
//
// Everything that decides something calls writeAudit(...) directly.

import { statement } from "./db/connection.js";
import { INSERT_AUDIT } from "./db/sql.js";

/** Canonical action names. Strings live here, not scattered in routers. */
export const AuditAction = Object.freeze({
  // Older databases also hold auth.team_login.* / auth.admin_login.* rows from
  // the shared-passcode era; nothing writes them any more.
  LOGIN_SUCCESS: "auth.login.success",
  LOGIN_FAILURE: "auth.login.failure",
  LOCKOUT: "auth.lockout",
  LOGOUT: "auth.logout",
  PASSWORD_CHANGED: "auth.password.changed",
  PASSWORD_RESET_ISSUED: "auth.password.reset_issued",

  EXPENSE_MATCH: "expense.decision.match",
  EXPENSE_MISMATCH: "expense.decision.mismatch",
  EXPENSE_UNREADABLE: "expense.decision.unreadable",
  EXPENSE_DUPLICATE: "expense.duplicate_hash",
  EXPENSE_REVIEW_APPROVED: "expense.review.approved",
  EXPENSE_REVIEW_REJECTED: "expense.review.rejected",
  EXPENSE_REVIEW_MOVE_FAILED: "expense.review.move_failed",
  EXPENSE_REVIEW_CONFLICT: "expense.review.conflict",
  EXPENSE_REVIEW_TX_FAILED: "expense.review.tx_failed",

  ACCESS_DENIED: "access.denied",

  MEMBER_CREATED: "member.created",
  ACCOUNT_CREATED: "member.account_created",
  MEMBER_DISABLED: "member.disabled",
  MEMBER_ENABLED: "member.enabled",
  MEMBER_UNLOCKED: "member.unlocked",
  MEMBER_ROLE_CHANGED: "member.role_changed",
  MEMBER_RENAMED: "member.renamed",
  MEMBER_USERNAME_CHANGED: "member.username_changed",

  ADMIN_VIEW: "admin.view",
  ADMIN_EXPORT_CSV: "admin.export_csv",
  ADMIN_EXPORT_XLSX: "admin.export_xlsx",
  ADMIN_VIEW_AUDIT: "admin.view_audit",
  ADMIN_VIEW_MEMBERS: "admin.view_members",
});

/** Same shape as Python's isoformat(timespec="seconds") in UTC. */
export function utcNowIso() {
  return new Date().toISOString().slice(0, 19) + "+00:00";
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}

/**
 * Insert one audit row and return its id.
 *
 * node:sqlite runs in autocommit mode, so outside a transaction the row is
 * durable when this returns — which is what the auth and denial paths need.
 * Inside inTransaction() it commits together with the decision it records.
 */
export function writeAudit(
  db,
  { actorKind, actorName, action, subjectType, subjectId = null, outcome, detail = {}, clientIp = "" },
) {
  const result = statement(db, INSERT_AUDIT).run(
    utcNowIso(),
    actorKind,
    actorName,
    action,
    subjectType,
    subjectId === null || subjectId === undefined ? null : String(subjectId),
    outcome,
    JSON.stringify(sortKeysDeep(detail ?? {})),
    clientIp,
  );
  return Number(result.lastInsertRowid);
}
