// What a non-admin session may see of an expense.
//
// The submitting member is never told whether their bill checked out: no
// verdict, extracted amount, difference, tolerance, flag, duplicate link or
// extractor detail. Those are computed, stored and audited exactly as before
// and stay visible to the admin. This is an allow-list on purpose: a column
// added to `expenses` later stays hidden from members until someone decides
// otherwise here.

const MEMBER_FIELDS = Object.freeze([
  "id",
  "created_at",
  "member_name",
  "category",
  "note",
  "claimed_amount",
]);

/** The member-safe projection of an expense row. */
export function memberExpenseView(row) {
  return Object.fromEntries(MEMBER_FIELDS.map((field) => [field, row[field] ?? null]));
}
