// Money totals per member and for the whole team — the ONE aggregate behind
// both the admin dashboard and the xlsx export, so the two can never disagree.
//
// SQLite sums REAL columns in binary floating point (0.1 + 0.2 ≠ 0.3), so each
// sum is rounded to satang the way the rest of the app rounds (pyRound2).

import { statement } from "./db/connection.js";
import { SELECT_GRAND_TOTALS, SELECT_TOTALS_BY_MEMBER } from "./db/sql.js";
import { pyRound2 } from "../shared/numbers.js";

const MONEY_KEYS = ["claimed_total", "verified_total", "pending_total", "rejected_total"];
const COUNT_KEYS = ["n", "pending_count", "rejected_count"];

function normalize(row) {
  const out = { ...row };
  for (const key of MONEY_KEYS) out[key] = pyRound2(Number(row[key] ?? 0));
  for (const key of COUNT_KEYS) out[key] = Number(row[key] ?? 0);
  out.last_upload = row.last_upload ?? null;
  return out;
}

/** { members: [...per member], grand: {...} } — see SELECT_TOTALS_BY_MEMBER. */
export function loadTotals(db) {
  const members = statement(db, SELECT_TOTALS_BY_MEMBER).all().map((row) => {
    const out = normalize(row);
    out.member_id = Number(row.member_id);
    // `total` kept for older dashboard consumers; same as claimed_total.
    out.total = out.claimed_total;
    return out;
  });
  const grand = normalize(statement(db, SELECT_GRAND_TOTALS).get() ?? {});
  return { members, grand };
}
