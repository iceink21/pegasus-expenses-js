// Startup migrations: link expenses to the members table, then add the
// evidence-review columns.
//
// Databases created before typed member names have no members table and no
// expenses.member_id. The CREATE TABLE IF NOT EXISTS statements in sql.js add
// the members table; this adds the column, its index, and backfills every
// unlinked expense by its stored member_name. Each step checks the current
// state first, so running it on every start is a no-op once applied, and the
// whole thing is one transaction: a failure leaves the database as it was.
//
// Backfill is lenient on purpose. Stored names were accepted by an older rule,
// so they are normalized and linked as they are rather than validated against
// the stricter rule for new input; an empty result is the only case remapped.
//
// Review columns (review_status … review_note) are appended after member_id in
// the same order as the fresh schema. Rows that predate them are backfilled
// once (WHERE review_status IS NULL): a clean MATCH is "verified", anything
// else "pending", and evidence_folder "legacy" — their files are not moved.
//
// Account columns (username … setup_code_expires_at) are appended to members
// first, in the fresh schema's order. Every member without a username — those
// that predate accounts, and any the expense backfill just created — gets the
// placeholder "member<id>" and no credential, so nobody can log in as them
// until an admin issues a setup code. Ids, names and expense links are kept.

import { createLogger } from "../log.js";
import { normalizeMemberName, resolveOrCreateMemberInTx } from "../members.js";
import { inTransaction, statement } from "./connection.js";
import {
  ALTER_EXPENSES_ADD_MEMBER_ID,
  MEMBER_ACCOUNT_COLUMN_ALTERS,
  REVIEW_COLUMN_ALTERS,
  SCHEMA_IDX_EXPENSES_MEMBER_ID,
  SCHEMA_IDX_MEMBER_USERNAME,
  SELECT_EXPENSE_COLUMNS,
  SELECT_MEMBER_COLUMNS,
  SELECT_UNLINKED_MEMBER_NAMES,
  UPDATE_BACKFILL_REVIEW_STATUS,
  UPDATE_BACKFILL_USERNAMES,
  UPDATE_LINK_EXPENSES_TO_MEMBER,
} from "./sql.js";

const logger = createLogger("pegasus.migrate");
const UNNAMED_MEMBER = "(ไม่ระบุชื่อ)";

export function migrate(db) {
  return inTransaction(db, () => {
    const memberColumns = new Set(statement(db, SELECT_MEMBER_COLUMNS).all().map((row) => row.name));
    const addedAccountColumns = [];
    for (const [name, alter] of MEMBER_ACCOUNT_COLUMN_ALTERS) {
      if (memberColumns.has(name)) continue;
      db.prepare(alter).run();
      addedAccountColumns.push(name);
    }
    db.prepare(SCHEMA_IDX_MEMBER_USERNAME).run();

    const columns = new Set(statement(db, SELECT_EXPENSE_COLUMNS).all().map((row) => row.name));
    const addedColumn = !columns.has("member_id");
    if (addedColumn) db.prepare(ALTER_EXPENSES_ADD_MEMBER_ID).run();
    db.prepare(SCHEMA_IDX_EXPENSES_MEMBER_ID).run();

    let linkedRows = 0;
    let createdMembers = 0;
    for (const { member_name: stored } of statement(db, SELECT_UNLINKED_MEMBER_NAMES).all()) {
      const name = normalizeMemberName(stored) || UNNAMED_MEMBER;
      const member = resolveOrCreateMemberInTx(db, name, {
        actorKind: "system",
        actorName: "migration",
        source: "migration",
      });
      if (member.created) createdMembers += 1;
      linkedRows += Number(statement(db, UPDATE_LINK_EXPENSES_TO_MEMBER).run(member.id, stored).changes);
    }

    if (addedColumn || linkedRows > 0) {
      logger.info(
        "members migration: " +
          (addedColumn ? "added expenses.member_id; " : "") +
          "linked " + linkedRows + " expense rows, created " + createdMembers + " members",
      );
    }

    const addedReviewColumns = [];
    for (const [name, alter] of REVIEW_COLUMN_ALTERS) {
      if (columns.has(name)) continue;
      db.prepare(alter).run();
      addedReviewColumns.push(name);
    }
    const backfilledRows = Number(statement(db, UPDATE_BACKFILL_REVIEW_STATUS).run().changes);
    if (addedReviewColumns.length > 0 || backfilledRows > 0) {
      logger.info(
        "review migration: added " + (addedReviewColumns.join(", ") || "no columns") +
          "; backfilled " + backfilledRows + " expense rows",
      );
    }
    // After the expense backfill, which may have created members.
    const placeholderUsernames = Number(statement(db, UPDATE_BACKFILL_USERNAMES).run().changes);
    if (addedAccountColumns.length > 0 || placeholderUsernames > 0) {
      logger.info(
        "accounts migration: added " + (addedAccountColumns.length > 0 ? addedAccountColumns.length + " member columns" : "no columns") +
          "; " + placeholderUsernames + " members given a placeholder username (no login until a setup code is issued)",
      );
    }
    return {
      addedColumn,
      linkedRows,
      createdMembers,
      addedReviewColumns,
      backfilledRows,
      addedAccountColumns,
      placeholderUsernames,
    };
  }, { immediate: true });
}
