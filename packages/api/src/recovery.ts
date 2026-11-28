// SPDX-License-Identifier: LicenseRef-Proprietary
import { assertPasskey, setRecoveryNotifier } from "./auth";
import { api, unwrap } from "./client";
import {
  cancelledRecoveryNotice,
  dismissCancelledRecoveryNotice,
  noteCancelledRecovery,
  subscribeCancelledRecovery,
} from "./recovery-notice";
import type { components } from "./schema";
import { authPost, session } from "./session";

setRecoveryNotifier(noteCancelledRecovery);
export { cancelledRecoveryNotice, dismissCancelledRecoveryNotice, subscribeCancelledRecovery };

type RecoveryStatus = components["schemas"]["RecoveryStatusResponse"];
type RecoveryContactStatus = components["schemas"]["RecoveryContactStatus"];
type GeneratedRecoveryCodes = components["schemas"]["GenerateRecoveryCodesResponse"];

/** Capability-safe status read: returns `null` when an older server does not expose self-recovery yet. */
export async function recoveryStatus(): Promise<RecoveryStatus | null> {
  const res = await api.GET("/api/v1/auth/recovery/status");
  if (res.response.status === 404 || res.response.status === 405 || res.response.status === 501) return null;
  return unwrap(Promise.resolve(res));
}

export async function upsertRecoveryContact(opts: {
  channel: components["schemas"]["UpsertRecoveryContactRequest"]["channel"];
  value: string;
  consentAccepted: boolean;
  stepUp?: boolean;
}): Promise<RecoveryContactStatus> {
  const step_up = opts.stepUp ? await assertPasskey() : undefined;
  return unwrap(
    api.PUT("/api/v1/auth/recovery/contact", {
      body: {
        channel: opts.channel,
        value: opts.value,
        consent_accepted: opts.consentAccepted,
        ...(step_up ? { step_up } : {}),
      },
    }),
  );
}

export async function generateRecoveryCodes(opts: { stepUp?: boolean } = {}): Promise<GeneratedRecoveryCodes> {
  const step_up = opts.stepUp ? await assertPasskey() : undefined;
  return unwrap(
    api.POST("/api/v1/auth/recovery/codes/generate", {
      body: step_up ? { step_up } : {},
    }),
  );
}

export const startRecoveryChallenge = (identifier: string) =>
  authPost<components["schemas"]["RecoveryChallengeResponse"]>("/api/v1/auth/recovery/challenge", { identifier });

export async function redeemRecoveryCode(recoveryCode: string, contactCode: string) {
  const tokens = await authPost<components["schemas"]["RecoveryRedeemResponse"]>("/api/v1/auth/recovery/redeem", {
    recovery_code: recoveryCode,
    contact_code: contactCode,
  });
  noteCancelledRecovery(Boolean(tokens.cancelled_recovery_request));
  session.set(tokens);
}
