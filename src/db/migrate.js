// Startup migration: link expenses to the members table.
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

import { createLogger } from "../log.js";
import { normalizeMemberName, resolveOrCreateMemberInTx } from "../members.js";
import { inTransaction, statement } from "./connection.js";
import {
  ALTER_EXPENSES_ADD_MEMBER_ID,
  SCHEMA_IDX_EXPENSES_MEMBER_ID,
  SELECT_EXPENSE_COLUMNS,
  SELECT_UNLINKED_MEMBER_NAMES,
  UPDATE_LINK_EXPENSES_TO_MEMBER,
} from "./sql.js";

const logger = createLogger("pegasus.migrate");
const UNNAMED_MEMBER = "(ไม่ระบุชื่อ)";

export function migrate(db) {
  return inTransaction(db, () => {
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
    return { addedColumn, linkedRows, createdMembers };
  }, { immediate: true });
}
