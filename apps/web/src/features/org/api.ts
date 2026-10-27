import { api, ApiError, assertPasskey, session, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { get, read } from "../../lib/query";
import { landed, LANDED } from "../../lib/react/landed";

type ChangeStatus = components["schemas"]["OrgChangeStatus"];
type Detail = components["schemas"]["OrgChangeDetail"];
type Op = components["schemas"]["OrgProposalOp"];
export const CHANGES_PAGE = 50;
/** The newest changes in any of `status` (one server query), optionally only one drafter's. */
export const changesByStatusQuery = (status: readonly ChangeStatus[], opts: { draftedBy?: string; limit?: number } = {}) =>
  get("/api/v1/org-changes", { params: { query: { status: [...status], drafted_by: opts.draftedBy, limit: opts.limit ?? 200 } } });
/** The signed-in user's id, as changes record their drafter. */
export const me = () => session.claims?.sub;
/** Statuses that still need someone to act. */
export const OPEN_CHANGE_STATUSES = ["DRAFT", "PRECHECKED", "IN_APPROVAL", "APPROVED", "SETTLING"] as const satisfies readonly ChangeStatus[];

// Commands the proposal card sends. Drafting carries an Idempotency-Key (a retry replays the same draft);
// the PATCH and the submit carry none, so the card probes the record after a lost response (lib/react/landed).
type S = components["schemas"];
const once = (key: string) => ({ "Idempotency-Key": key });
const at = (id: string) => ({ path: { id } });

/** Drafts any org change in one write: its ops, date and reason together. */
export const draftChange = (key: string, body: S["CreateOrgChangeRequest"]) => unwrap(api.POST("/api/v1/org-changes", { params: { header: once(key) }, body }));
/** Sets a draft's date and reason (the region and branch drafting URLs take neither). */
export const dateDraft = (id: string, body: { effectiveDate: string; reason: string }) => unwrap(api.PATCH("/api/v1/org-changes/{id}", { params: at(id), body }));
const submitChange = (id: string) => unwrap(api.POST("/api/v1/org-changes/{id}/submit", { params: at(id) }));
const readChange = (id: string) => api.GET("/api/v1/org-changes/{id}", { params: at(id) });
/**
 * Submits a draft: "unsent" when its preflight blocks it (the draft stays, its page shows why). Submit takes
 * no Idempotency-Key, so after a lost response or a 409 the change itself says whether it already went.
 */
export async function submitDraft(id: string): Promise<"sent" | "unsent"> {
  try {
    await landed(() => submitChange(id), () => readChange(id), (d) => d.status !== "DRAFT" && d.status !== "PRECHECKED");
    return "sent";
  } catch (e) {
    if (e instanceof ApiError && e.code === "preflight_blocked") return "unsent";
    throw e;
  }
}

/**
 * Adds one op to the end of a draft's proposal, so several edits go to approval as one change. The PATCH
 * replaces the whole list and takes no Idempotency-Key: after a lost response the draft itself says whether
 * the op is already there. last read wins (no `test` on the PATCH); the server's DRAFT-only rule
 * still refuses once it is submitted.
 */
export async function appendOp(id: string, op: S["OrgProposalOp"]) {
  const before = (await unwrap(readChange(id))).proposal;
  const same = (o: S["OrgProposalOp"]) => JSON.stringify(o) === JSON.stringify(op);
  const has = (d: S["OrgChangeDetail"]) => d.proposal.filter(same).length > before.filter(same).length;
  await landed(() => unwrap(api.PATCH("/api/v1/org-changes/{id}", { params: at(id), body: { proposal: [...before, op] } })), () => readChange(id), has);
}

// Region and branch drafts go through their own URLs: those add the region/branch capability check and the
// tenant's target checks that the generic create does not.
export const draftRegion = (key: string, name: string) => unwrap(api.POST("/api/v1/regions", { params: { header: once(key) }, body: { name } }));
export const draftRegionRename = (key: string, id: string, name: string) => unwrap(api.PATCH("/api/v1/regions/{id}", { params: { header: once(key), ...at(id) }, body: { name } }));
export const draftRegionClose = (key: string, id: string) => unwrap(api.DELETE("/api/v1/regions/{id}", { params: { header: once(key), ...at(id) } }));
export const draftBranch = (key: string, regionId: string, name: string) => unwrap(api.POST("/api/v1/branches", { params: { header: once(key) }, body: { region_id: regionId, name } }));
export const draftBranchUpdate = (key: string, id: string, body: { name?: string; region_id?: string }) =>
  unwrap(api.PATCH("/api/v1/branches/{id}", { params: { header: once(key), ...at(id) }, body }));
export const draftBranchClose = (key: string, id: string) => unwrap(api.DELETE("/api/v1/branches/{id}", { params: { header: once(key), ...at(id) } }));

/** The change list's saved views (routes/org.ts `view`): which statuses, and whose drafts. */
export const CHANGE_VIEWS = {
  open: { status: OPEN_CHANGE_STATUSES, mine: false },
  mine: { status: [], mine: true },
  approval: { status: ["IN_APPROVAL"], mine: false },
  ready: { status: ["APPROVED"], mine: false },
  done: { status: ["APPLIED", "ARCHIVED"], mine: false },
  closed: { status: ["REJECTED", "CANCELLED"], mine: false },
  all: { status: [], mine: false },
} as const satisfies Record<string, { status: readonly ChangeStatus[]; mine: boolean }>;
export type ChangeView = keyof typeof CHANGE_VIEWS;
type EffectiveRange = { effective_from?: string; effective_to?: string };
/** One page of a view; `limit: 1` reads only its count (`total`). */
export const changesViewQuery = (view: ChangeView, offset: number, limit = CHANGES_PAGE, range: EffectiveRange = {}) => {
  const v = CHANGE_VIEWS[view];
  return get("/api/v1/org-changes", {
    params: { query: { status: v.status.length ? [...v.status] : undefined, drafted_by: v.mine ? me() : undefined, offset, limit, ...range } },
  });
};

/**
 * The signed-in user's own changes, every status: Home's lanes and the list's redraft lead read this one entry.
 * the newest MY_CHANGES only; an open draft or a rejection older than that is missed until the server
 * filters "open, or rejected and not redrafted" itself (backend PEOPLE-GAPS).
 */
export const MY_CHANGES = 200;
export const myChangesQuery = (range: EffectiveRange = {}) => changesViewQuery("mine", 0, MY_CHANGES, range);

export const changeQuery = (id: string) => get("/api/v1/org-changes/{id}", { params: { path: { id } } });

const onChange = (id: string) => ({ params: { path: { id } } });
/** Every command on one change. Only create carries an Idempotency-Key today; the others are probed (lib/react/landed). */
export const changeCommands = (id: string) => ({
  preflight: () => unwrap(api.POST("/api/v1/org-changes/{id}/preflight", onChange(id))),
  submit: () => unwrap(api.POST("/api/v1/org-changes/{id}/submit", onChange(id))),
  cancel: (reason: string) => unwrap(api.POST("/api/v1/org-changes/{id}/cancel", { ...onChange(id), body: { reason } })),
  effectuate: () => unwrap(api.POST("/api/v1/org-changes/{id}/effectuate", onChange(id))),
  archive: () => unwrap(api.POST("/api/v1/org-changes/{id}/archive", onChange(id))),
  edit: (body: { effectiveDate?: string; reason?: string }) => unwrap(api.PATCH("/api/v1/org-changes/{id}", { ...onChange(id), body })),
  decide: (stepId: string, decision: "APPROVED" | "REJECTED", memo?: string) =>
    unwrap(api.POST("/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", { params: { path: { id, stepId } }, body: { decision, memo } })),
  settle: (itemId: string, memo?: string) =>
    unwrap(api.POST("/api/v1/org-changes/{id}/settlement-items/{itemId}/complete", { params: { path: { id, itemId } }, body: { memo } })),
});

/** A new draft carrying a rejected change's content (`supersedesId`), with its own date and reason. */
export const redraftChange = (d: Detail, body: { effectiveDate: string; reason: string }, key: string) =>
  unwrap(
    api.POST("/api/v1/org-changes", {
      params: { header: { "Idempotency-Key": key } },
      body: { kind: d.kind, target: d.target, proposal: d.proposal, supersedesId: d.id, ...body },
    }),
  );

/** The unit a change is about: the unit its first unit op names (a create names its parent), else an ORG_UNIT target. */
export function changeUnitId(d: { target: Detail["target"]; proposal?: Op[] }): string | undefined {
  for (const op of d.proposal ?? []) {
    if (op.op === "DISSOLVE_ORG_UNIT" || op.op === "RENAME_ORG_UNIT" || op.op === "MOVE_ORG_UNIT") return op.orgUnitId;
    if (op.op === "REASSIGN_ORG_UNIT") return op.fromOrgUnit;
    if (op.op === "CREATE_ORG_UNIT") return op.parentId ?? undefined;
  }
  return d.target.kind === "ORG_UNIT" && d.target.ref !== NO_REF ? d.target.ref : undefined;
}
/** The ref the server gives a target that does not exist yet (a site or region being created). */
export const NO_REF = "00000000-0000-0000-0000-000000000000";

/** How a refused command reads on the record. Everything else is shown as the server's message. */
export type Refusal = "preflight_blocked" | "frozen" | "conflict" | "date" | "other";
export function refusalOf(e: unknown, effectiveDate?: string): Refusal {
  if (!(e instanceof ApiError)) return "other";
  if (e.code === "preflight_blocked") return "preflight_blocked";
  // the payroll/accounting freeze is a 409 `conflict` whose message names the effective date
  // (orgchange assert_change_window_open); switch to its own code once the backend sends one (§9 effective_date_frozen).
  if (e.status === 409 && effectiveDate && e.message.includes(effectiveDate)) return "frozen";
  if (e.status === 409) return "conflict";
  // 422 carries no field pointer; the only date rule today is "today or later (KST)".
  if (e.status === 422 && /effectiveDate|effective_date/.test(e.message)) return "date";
  return "other";
}
/** How many blockers a `preflight_blocked` refusal names (every blocker code is in `reasons`). */
export const blockerCount = (e: unknown) => (e instanceof ApiError ? e.reasons.length : 0);
/** The server's own words for a refusal (shown inside a blocked panel). */
export const refusalMessage = (e: unknown) => (e instanceof ApiError && e.fromServer ? e.message : undefined);

/** Who already did what a command asked, when it was not this viewer: a 409 retry that someone else beat (3.7). */
export type Elsewhere = { name: string | null; at?: string };
/** The status change into one of `to`, when someone other than this viewer made it. */
export function movedElsewhere(d: Detail, to: readonly string[]): Elsewhere | undefined {
  const e = [...d.events].reverse().find((x) => x.toStatus !== undefined && to.includes(x.toStatus));
  return e && e.actor !== me() ? { name: e.actorName, at: e.at } : undefined;
}
/**
 * A command without an Idempotency-Key, probed (lib/react/landed): resolves to undefined when this viewer's
 * command took effect, or to who did it first when the record already showed it done by someone else.
 */
export async function probed(run: () => Promise<unknown>, refetch: () => Promise<{ data?: Detail }>, took: (d: Detail) => boolean, by: (d: Detail) => Elsewhere | undefined) {
  if ((await landed(run, refetch, took)) !== LANDED) return undefined;
  const now = (await refetch()).data;
  return now && by(now);
}

/** The tenant settings in force; the org screens read `approval.policy.org_structure` from it (decisions #26). */
export const orgPolicyQuery = { ...get("/api/v1/settings"), staleTime: 5 * 60_000 };

/**
 * One proposal for a structure change after go-live: drafted with its ops, date and reason, then submitted unless
 * only saved. "unsent": its preflight blocks it; the draft stays and its record says why.
 */
export async function governed(key: string, body: S["CreateOrgChangeRequest"], submit: boolean) {
  const draft = await draftChange(key, body);
  const sent = submit ? await submitDraft(draft.id) : ("saved" as const);
  const result = sent === "sent" ? await unwrap(readChange(draft.id)) : draft;
  return { id: draft.id, code: draft.code, sent, select: result.created_unit_ids?.[0] };
}

// --- lane: UX-R2 ORGCHANGE (org-06) ---
/** Live access grants: the dissolve sheet reads the ones scoped to the closing department. */
/**
 * The live grants, held as `{ items }` under the same key the access screens use (features/access `list`), so one cache
 * entry never holds two shapes (the bare array crashed the dissolution sheet once the access screens had read it).
 */
export const grantsQuery = { ...read("/api/v1/access/grants", async () => ({ items: await unwrap(api.GET("/api/v1/access/grants")) })), refetchOnMount: "always" as const };
/**
 * Re-points or ends grants as one batch: the server checks each operation (preview), then the receipt is applied with
 * the actor's passkey. "refused" when the server refused any operation; nothing is written then.
 */
export async function settleGrants(body: S["AccessGrantBatchRequest"]) {
  const p = await unwrap(api.POST("/api/v1/access/grants/preview", { body }));
  if (p.refused) return "refused" as const;
  await unwrap(api.POST("/api/v1/access/grants/apply", { body: { receipt_id: p.receipt_id, step_up: await assertPasskey() } }));
  return "done" as const;
}

// --- lane: CRUD ---
/**
 * Ending a department honestly (CRUD): the server says whether it is deleted (never used: it and its sub-departments
 * leave the record, audited) or dissolution (used: closed, history kept), and the code for the way it does not offer.
 */
export { unitEndQuery } from "../../reference/org/api";

const unitAt = (key: string, id: string) => ({ header: { "Idempotency-Key": key }, path: { orgUnitId: id } });

/** Deletes a never-used department and its sub-departments, pinned to the version read. */
export const eraseUnit = (key: string, id: string, version: number) =>
  unwrap(api.POST("/api/v1/org-structure/units/{orgUnitId}/erase", { params: unitAt(key, id), body: { expected_version: version } }));

/** dissolution of a used department now (setup: undoable; after go-live: applied at once while org changes are not routed). */
export const dissolveUnit = (key: string, id: string, version: number) =>
  unwrap(api.POST("/api/v1/org-structure/units/{orgUnitId}/dissolve", { params: unitAt(key, id), body: { expected_version: version } }));

/** A department's head and code, as their full new values (null clears), in either phase. */
const setUnitDetails = (key: string, id: string, body: { expected_version: number; code: string | null; head_employee_id: string | null }) =>
  unwrap(api.PUT("/api/v1/org-structure/units/{orgUnitId}/details", { params: unitAt(key, id), body }));

/** Head appointment uses the existing details command with its version and code. */
export const appointHead = (key: string, unitId: string, employeeId: string | null, details: { expected_version: number; code: string | null }) =>
  setUnitDetails(key, unitId, { ...details, head_employee_id: employeeId });


/** Every scheduled action for one unit, read atomically before the timeline is shown. */
export const scheduledUnitChangesQuery = (unitId: string) => {
  const query = { status: ["APPROVED" as const], target_ref: unitId, limit: CHANGES_PAGE };
  return read("/api/v1/org-changes", async () => {
    const items: S["OrgChangeSummary"][] = [];
    let total = 0;
    do {
      const page = await unwrap(api.GET("/api/v1/org-changes", { params: { query: { ...query, offset: items.length } } }));
      items.push(...page.items);
      total = page.total;
      if (!page.items.length && items.length < total) throw new Error("org-change timeline is incomplete");
    } while (items.length < total);
    return items;
  }, { query });
};
