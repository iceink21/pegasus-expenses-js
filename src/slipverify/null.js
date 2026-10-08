// No-op slip verifier — the only implementation in v1.

import { slipVerification, VerificationStatus } from "./base.js";

export class NullSlipVerifier {
  name = "NullSlipVerifier";
  enabled = false;

  async verify() {
    return slipVerification({
      status: VerificationStatus.NOT_ATTEMPTED,
      detail: "slip verification is out of scope for v1",
    });
  }
}
