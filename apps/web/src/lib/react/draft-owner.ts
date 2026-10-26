// SPDX-License-Identifier: LicenseRef-Proprietary
const DRAFT_PREFIX = "console.draft:";
export const DRAFT_OWNER = "console.draft.principal";
// shortcut: migrate legacy attendance keys for one release after deployment, then remove the legacy path.
export const LEGACY_ATTENDANCE_PREFIX = "console.attendance.drafts:";
export const draftKey = (principal: string, route: string, record: string, form: string) => DRAFT_PREFIX + JSON.stringify([principal, route, record, form]);
/** Forms and custom stores share one recovery clipboard registry. */
export const activeDrafts = new Map<string, { principal: string; text: () => string }>();

export function registerDraft(key: string, draft: { principal: string; text: () => string }) {
  activeDrafts.set(key, draft);
  return () => { if (activeDrafts.get(key) === draft) activeDrafts.delete(key); };
}

/** Called before the new account's screen can render; an ended session still owns its drafts. */
export function syncDraftPrincipal(principal: string | null) {
  for (const [key, draft] of activeDrafts) if (draft.principal !== principal) activeDrafts.delete(key);
  try {
    if (principal !== null && sessionStorage.getItem(DRAFT_OWNER) === principal) return null;
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(DRAFT_PREFIX) || key.startsWith(LEGACY_ATTENDANCE_PREFIX)) sessionStorage.removeItem(key);
    if (principal) sessionStorage.setItem(DRAFT_OWNER, principal);
    else sessionStorage.removeItem(DRAFT_OWNER);
    return null;
  } catch {
    // Storage may be blocked; account-scoped keys and the live principal still prevent disclosure.
    return "unavailable" as const;
  }
}
