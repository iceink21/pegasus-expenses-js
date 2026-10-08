// Slip bank-verification seam.
//
// OUT OF SCOPE FOR v1 — deliberately. A real verifier hits a paid
// bank/aggregator API with the slip's transaction reference to confirm the
// transfer actually happened. v1 ships the interface plus a no-op so that
// adding one later is a new class and one line in providers.js, not a rewrite
// of the decision path.
//
// A slip verifier is any object with
//     name: string
//     enabled: boolean
//     verify({ imageBytes, claimedAmount }): Promise<SlipVerification>

export const VerificationStatus = Object.freeze({
  NOT_ATTEMPTED: "not_attempted",
  VERIFIED: "verified",
  NOT_FOUND: "not_found",
  ERROR: "error",
});

export function slipVerification({
  status = VerificationStatus.NOT_ATTEMPTED,
  amount = null,
  reference = null,
  detail = "",
  raw = {},
} = {}) {
  return Object.freeze({
    status,
    amount,
    reference,
    detail,
    raw,
    attempted: status !== VerificationStatus.NOT_ATTEMPTED,
  });
}
