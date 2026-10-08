// SQLite access via the built-in node:sqlite module (Node >= 22.13), so there
// is no native addon to compile on the deploy target.
//
// One DatabaseSync handle serves the whole process. Node runs handlers on one
// thread and every statement here is synchronous, so a BEGIN..COMMIT block
// that contains no `await` cannot interleave with another request.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  PRAGMA_BUSY_TIMEOUT,
  PRAGMA_FOREIGN_KEYS,
  PRAGMA_WAL,
  SCHEMA_STATEMENTS,
  TX_BEGIN,
  TX_COMMIT,
  TX_ROLLBACK,
} from "./sql.js";

const statementCache = new WeakMap();

/** Prepared statement for `sql` on `db`, prepared once and reused. */
export function statement(db, sql) {
  let byText = statementCache.get(db);
  if (!byText) {
    byText = new Map();
    statementCache.set(db, byText);
  }
  let prepared = byText.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    byText.set(sql, prepared);
  }
  return prepared;
}

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  for (const pragma of [PRAGMA_WAL, PRAGMA_FOREIGN_KEYS, PRAGMA_BUSY_TIMEOUT]) {
    db.prepare(pragma).get();
  }
  for (const ddl of SCHEMA_STATEMENTS) {
    db.prepare(ddl).run();
  }
  return db;
}

/**
 * Run `work(db)` inside one transaction. `work` must be synchronous: an await
 * inside it would let another request's statements join this transaction.
 */
export function inTransaction(db, work) {
  statement(db, TX_BEGIN).run();
  try {
    const result = work(db);
    if (result && typeof result.then === "function") {
      throw new TypeError("inTransaction work must be synchronous");
    }
    statement(db, TX_COMMIT).run();
    return result;
  } catch (error) {
    statement(db, TX_ROLLBACK).run();
    throw error;
  }
}
