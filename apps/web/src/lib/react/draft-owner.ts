// SPDX-License-Identifier: LicenseRef-Proprietary
export const DRAFT_PREFIX = "console.draft:";
const OWNER = "console.draft.principal";
/** Mounted forms' drafts, keyed by draft key; useDraft registers here. */
export const activeDrafts = new Map<string, { principal: string; text: () => string }>();

/** Called before the new account's screen can render; an ended session still owns its drafts. */
export function syncDraftPrincipal(principal: string | null) {
  for (const [key, draft] of activeDrafts) if (draft.principal !== principal) activeDrafts.delete(key);
  try {
    if (principal !== null && sessionStorage.getItem(OWNER) === principal) return null;
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(DRAFT_PREFIX)) sessionStorage.removeItem(key);
    if (principal) sessionStorage.setItem(OWNER, principal);
    else sessionStorage.removeItem(OWNER);
    return null;
  } catch {
    // Storage may be blocked; account-scoped keys and the live principal still prevent disclosure.
    return "unavailable" as const;
  }
}
