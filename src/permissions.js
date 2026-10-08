// Permission (what action) vs scope (which row) — one shared util.
//
// - PERMISSION answers "may this principal perform this action at all?"
// - SCOPE answers "may this principal touch this particular row?"
//
// Both reads and writes go through canAccess / requireAccess. Scoping only the
// list query and forgetting the mutation endpoints is a known way to leak rows
// across boundaries, so the scope check is a single function that every
// handler calls, read or write.

import { AuditAction, writeAudit } from "./audit.js";

export const Action = Object.freeze({
  EXPENSE_CREATE: "expense:create",
  EXPENSE_READ_OWN: "expense:read_own",
  EXPENSE_READ_ALL: "expense:read_all",
  EXPENSE_EXPORT: "expense:export",
  AUDIT_READ: "audit:read",
});

const MEMBER_PERMISSIONS = new Set([Action.EXPENSE_CREATE, Action.EXPENSE_READ_OWN]);

const ADMIN_PERMISSIONS = new Set([
  Action.EXPENSE_CREATE,
  Action.EXPENSE_READ_OWN,
  Action.EXPENSE_READ_ALL,
  Action.EXPENSE_EXPORT,
  Action.AUDIT_READ,
]);

const ROLE_PERMISSIONS = { member: MEMBER_PERMISSIONS, admin: ADMIN_PERMISSIONS };

/**
 * Who is acting. `kind` is the role ("member" | "admin"); `name` the display
 * name; `memberId` the members.id bound to a team session at login (null for
 * admin).
 */
export function makePrincipal({ kind, name, memberId = null, clientIp = "" }) {
  return Object.freeze({ kind, name, memberId, clientIp, isAdmin: kind === "admin" });
}

export class PermissionDenied extends Error {
  constructor(action, reason = "permission") {
    super(reason + ":" + action);
    this.name = "PermissionDenied";
    this.action = action;
    this.reason = reason;
  }
}

export function hasPermission(principal, action) {
  return (ROLE_PERMISSIONS[principal.kind] ?? new Set()).has(action);
}

/** SCOPE check for a single expense row. Applies to reads AND writes. */
export function canAccess(principal, row) {
  if (principal.isAdmin) return true;
  // By id, never by name: two rows can carry the same display name.
  if (principal.memberId === null || row.member_id === null || row.member_id === undefined) return false;
  return Number(row.member_id) === principal.memberId;
}

/**
 * Throw PermissionDenied and AUDIT THE DENIAL at the point of denial.
 *
 * DECISION POINT: the audit row is written here, before the exception
 * propagates, so no error handler or middleware ordering can lose it.
 */
export function requirePermission(db, principal, action) {
  if (hasPermission(principal, action)) return;
  writeAudit(db, {
    actorKind: principal.kind,
    actorName: principal.name,
    action: AuditAction.ACCESS_DENIED,
    subjectType: "action",
    subjectId: action,
    outcome: "denied",
    detail: { reason: "missing_permission" },
    clientIp: principal.clientIp,
  });
  throw new PermissionDenied(action);
}

/** SCOPE gate with the same at-the-decision-point audit guarantee. */
export function requireAccess(db, principal, row, action) {
  if (canAccess(principal, row)) return;
  writeAudit(db, {
    actorKind: principal.kind,
    actorName: principal.name,
    action: AuditAction.ACCESS_DENIED,
    subjectType: "expense",
    subjectId: row.id,
    outcome: "denied",
    detail: { reason: "out_of_scope", action },
    clientIp: principal.clientIp,
  });
  throw new PermissionDenied(action, "scope");
}
