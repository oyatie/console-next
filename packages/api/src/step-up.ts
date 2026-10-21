import { api, unwrap } from "./client";
import { platform } from "./platform";
import type { components } from "./schema";

/** The BW-29 step-up kinds a web command binds its passkey assertion to (the server's step_up_kind.rs). */
export type StepUpKind = "PERIOD_UNLOCK" | "IDENTITY_MERGE" | "EXCEPTION_DECIDE";
const REASON_KEY: Record<StepUpKind, string> = { PERIOD_UNLOCK: "passkey_step_up_period_unlock", IDENTITY_MERGE: "passkey_step_up_identity_merge", EXCEPTION_DECIDE: "passkey_step_up_exception_decide" };

type Envelope = components["schemas"]["MobilePasskeyStepUpEnvelope"];

/** Lowercase hex SHA-256 of the UTF-8 text: the payload hash a bound step-up carries. */
export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A passkey assertion bound to one act (`kind`), its object and the hash of the exact payload the command sends:
 * the server starts a ceremony for that binding and accepts the assertion for nothing else.
 * the published MobilePasskeyStepUpBinding schema still lists only the two mobile kinds and no payload_hash
 * (backend ask: document the BW-29 kinds); the binding is cast until it does.
 */
export async function assertBoundPasskey(kind: StepUpKind, objectId: string, payload: string): Promise<Envelope> {
  const binding = { action_kind: kind, object_id: objectId, reason_key: REASON_KEY[kind], replay_attempt: null, payload_hash: await sha256Hex(payload) };
  const start = await unwrap(api.POST("/api/v1/auth/passkey/step-up/start", { body: { binding: binding as unknown as Envelope["binding"] } }));
  const { publicKey } = start.challenge as { publicKey: PublicKeyCredentialRequestOptionsJSON };
  const credential = await platform().passkeys.get(publicKey);
  if (!credential) throw new Error("passkey_cancelled");
  return { binding: binding as unknown as Envelope["binding"], assertion: { ceremony_id: start.ceremony_id, credential: credential as Record<string, unknown> } };
}
