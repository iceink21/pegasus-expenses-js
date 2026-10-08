// Audit log writes.
//
// DESIGN RULE (learned the hard way): the audit row is written *at the point of
// the decision*, inside the same transaction that records the decision — never
// in a wrapper, middleware, or response hook. A short-circuit return (403,
// duplicate, unreadable image, bad passcode, missing session) cannot skip an
// audit row that is written by the very function that produced the
// short-circuit.
//
// Everything that decides something calls writeAudit(...) directly.

import { statement } from "./db/connection.js";
import { INSERT_AUDIT } from "./db/sql.js";

/** Canonical action names. Strings live here, not scattered in routers. */
export const AuditAction = Object.freeze({
  LOGIN_TEAM_SUCCESS: "auth.team_login.success",
  LOGIN_TEAM_FAILURE: "auth.team_login.failure",
  LOGIN_ADMIN_SUCCESS: "auth.admin_login.success",
  LOGIN_ADMIN_FAILURE: "auth.admin_login.failure",
  LOGOUT: "auth.logout",

  EXPENSE_MATCH: "expense.decision.match",
  EXPENSE_MISMATCH: "expense.decision.mismatch",
  EXPENSE_UNREADABLE: "expense.decision.unreadable",
  EXPENSE_DUPLICATE: "expense.duplicate_hash",

  ACCESS_DENIED: "access.denied",

  ADMIN_VIEW: "admin.view",
  ADMIN_EXPORT_CSV: "admin.export_csv",
  ADMIN_VIEW_AUDIT: "admin.view_audit",
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
