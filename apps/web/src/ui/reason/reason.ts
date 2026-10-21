/** A reason as the user enters it: a code from the server's list (none yet: null) and a memo. */
export type Reason = { code: string | null; memo: string };

/**
 * What still blocks this reason (components.html §2): no code chosen, or Other (`other`) with an empty
 * memo. The server enforces the same rule; this only shows it at the field before sending.
 */
export function reasonProblem(reason: Reason, other: string): "pick" | "memo" | null {
  if (reason.code === null) return "pick";
  return reason.code === other && reason.memo.trim() === "" ? "memo" : null;
}
