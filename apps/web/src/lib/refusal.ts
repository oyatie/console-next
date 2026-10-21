import { ApiError } from "@console/api";
import { isMessageId, t } from "@console/i18n";

/**
 * What failed, in words the user can act on: catalog copy for an error code the client knows
 * (`common.failed.code.<code>`; the server's Korean for a code it has no translation of is only generic), else the
 * server's localized message when it sent one, otherwise catalog copy (never raw status text or a JS error string).
 * `own`: a screen's words for its codes (from the screen's catalog, loaded with it) come first.
 */
export function failureText(error: unknown, own?: (code: string) => string | undefined): string {
  const text = reason(error, own);
  // TS-28: a shed (503) or rate-limited (429) answer says when to come back; a command is never retried on its own.
  const wait = error instanceof ApiError && (error.status === 503 || error.status === 429) ? error.retryAfterMs : undefined;
  return wait === undefined ? text : `${text} ${t("common.failed.retryAfter", { seconds: String(Math.max(1, Math.ceil(wait / 1000))) })}`;
}

function reason(error: unknown, own?: (code: string) => string | undefined): string {
  const mine = own && error instanceof ApiError ? own(error.code) : undefined;
  if (mine) return mine;
  const byCode = error instanceof ApiError ? `common.failed.code.${error.code}` : "";
  if (isMessageId(byCode)) return t(byCode);
  const outcome = error instanceof ApiError ? `requestOutcome.code.${error.code}` : "";
  if (isMessageId(outcome)) return t(outcome);
  if (error instanceof ApiError) return error.fromServer ? error.message : t("common.failed.status", { status: String(error.status) });
  return t("common.networkError");
}

/**
 * Sign-in failures: the server's localized message, or catalog copy for anything else (a passkey
 * the browser refused, a browser too old for passkeys, a network fault) — never the browser's own
 * error text. A dismissed passkey prompt is not an error.
 */
export const signInError = (e: unknown) => {
  if (e instanceof Error && e.message === "passkey_cancelled") return null;
  // A client capability gap, not a connection fault: never the network message.
  if (e instanceof Error && e.message === "passkey_unavailable") return t("auth.passkey.unavailable");
  return e instanceof ApiError || e instanceof TypeError ? failureText(e) : t("auth.passkey.failed");
};
