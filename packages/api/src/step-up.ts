import { api, unwrap } from "./client";
import { platform } from "./platform";
import type { components } from "./schema";

/** The BW-29 step-up kinds a web command binds its passkey assertion to (the server's step_up_kind.rs). */
export type StepUpKind = "PII_REVEAL" | "PII_RECORD" | "PERIOD_UNLOCK" | "IDENTITY_MERGE" | "EXCEPTION_DECIDE" | "OPERATOR_RECOVERY" | "SUPPORT_SESSION" | "PRIVACY_REQUEST";
const reasonKey = (kind: StepUpKind): `passkey_step_up_${Lowercase<StepUpKind>}` => `passkey_step_up_${kind.toLowerCase() as Lowercase<StepUpKind>}`;

type Envelope = components["schemas"]["MobilePasskeyStepUpEnvelope"];

/** Lowercase hex SHA-256 of the UTF-8 text: the payload hash a bound step-up carries. */
export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A passkey assertion bound to one act (`kind`), its object and the hash of the exact payload the command sends:
 * the server starts a ceremony for that binding and accepts the assertion for nothing else.
 */
export async function assertBoundPasskey(kind: StepUpKind, objectId: string, payload: string): Promise<Envelope> {
  return assertBoundPasskeyHash(kind, objectId, await sha256Hex(payload));
}

/** Bind a server-computed fingerprint directly, preserving the payload the reviewer saw. */
export async function assertBoundPasskeyHash(kind: StepUpKind, objectId: string, payloadHash: string): Promise<Envelope> {
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new Error("passkey_payload_hash_invalid");
  const binding: Envelope["binding"] = { action_kind: kind, object_id: objectId, reason_key: reasonKey(kind), replay_attempt: null, payload_hash: payloadHash };
  const start = await unwrap(api.POST("/api/v1/auth/passkey/step-up/start", { body: { binding: binding } }));
  const { publicKey } = start.challenge as { publicKey: PublicKeyCredentialRequestOptionsJSON };
  const credential = await platform().passkeys.get(publicKey);
  if (!credential) throw new Error("passkey_cancelled");
  return { binding: binding, assertion: { ceremony_id: start.ceremony_id, credential: credential as Record<string, unknown> } };
}
