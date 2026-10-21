import { ApiError } from "@console/api";

/** What `landed` returns when the command's response was lost but the record shows it took effect. */
export const LANDED = Symbol("landed");

/**
 * Runs a command that carries no Idempotency-Key. When its response is lost (a network fault) or it is
 * refused because the state already moved (409: a retry of a command that already went through, or
 * someone else's; 404: what it removes is already gone), it re-reads the record and returns LANDED if
 * `took` holds there, so the caller shows the receipt instead of an error. Any other failure, a failed
 * re-read, or a record that does not show the change is thrown as it was.
 * `moved`: the statuses that may mean the change already went in. A command whose refusals are always answers
 * (onboarding: 409 is a slug someone else holds) passes `[]`, so only a response lost before any status re-reads.
 * a probe, not a guarantee; drop it per command once the server takes an Idempotency-Key (BW-21).
 */
export async function landed<O, D>(run: () => Promise<O>, refetch: () => Promise<{ data?: D }>, took: (d: D) => boolean, moved: readonly number[] = [404, 409]): Promise<O | typeof LANDED> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ApiError && e.status !== 0 && e.status < 500 && !moved.includes(e.status)) throw e;
    const now = await refetch().catch(() => ({ data: undefined }));
    if (now.data !== undefined && took(now.data)) return LANDED;
    throw e;
  }
}
