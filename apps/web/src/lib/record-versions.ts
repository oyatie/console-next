import { ownWrites } from "./pure/own-writes";

// The one place a write carrying a record's whole-record precondition (`expected_updated_at`) takes its version: every
// such writer, in any slice, goes through `pinned` (scripts/check-source.mjs rule 7 fails a slice file that sends one
// without it), so a command read before the user's own earlier write landed is not refused against that write.

/** This tab's own writes, per record key (`employees/<id>`), shared by every slice that writes one. */
const OWN = ownWrites();

/** The version to send for a write to `fields` read at `read`: past this tab's own writes to other fields since. */
export const versionToSend = (record: string, read: string, fields: readonly string[]) => OWN.base(record, read, fields);

/**
 * Sends a write at the version to send (above) and, when the answer names the version it produced (`produced`), keeps
 * that step so the next write past it goes too. An answer that names none (or a delete) ends the chain there: the next
 * write goes at what the screen read, and is refused stale until the re-read lands.
 */
export async function pinned<T>(record: string, read: string, fields: readonly string[], send: (at: string) => Promise<T>, produced?: (out: T) => string | null | undefined) {
  const at = versionToSend(record, read, fields);
  const out = await send(at);
  const to = produced?.(out);
  if (to) OWN.record(record, at, to, fields);
  return out;
}

/** The record key of one employee (the same key in every slice). */
export const employeeRecord = (id: string) => `employees/${id}`;
