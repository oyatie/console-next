// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { mountBrowserModule, type MountedGallery } from "../lib/gallery-browser-test";

const change = {
  id: "oc-1", code: "OC-2026-0999", kind: "REORG", status: "IN_APPROVAL",
  target: { kind: "ORG_UNIT", ref: "u-2", label: "Merge units" }, effectiveDate: "2026-12-01", reason: "Consolidation",
  headcount: 12, siteCount: 1, teamCount: 2, draftedBy: "user-1", draftedByName: "Lee",
  createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", proposal: [],
  approvalSteps: [{ id: "s-1", stepOrder: 1, roleKey: "hr", decision: "PENDING", decidedByName: null }],
  settlementItems: [], events: [],
};
const run = {
  id: "run-1", box: "pending", title: "Leave approval", summary: "Lee", document_no: "AP-2026-0192", decision_refusal: null,
  source: { key: "leave", label: "Leave" }, status: { key: "IN_APPROVAL" }, requester: { id: "u-1", name: "Lee" },
  requested_at: "2026-11-09T09:00:00+09:00", facts: [], route: [{ id: "st-1", role_key: "hr", assignee: "Moon", state: "current" }],
  viewer: { kind: "org_change", id: "run-1" }, body: [], revision: 1, fingerprint: "fp-1", consequence: "final", opinion_max: 500,
  my_actions: { kind: "approve", reject: { consequence: "request_ends", reason_domain: "org_change_reject" } },
};
// The three places that mark the viewer's turn: the worklist record of an org change and of an approval run, and the
// inbox command of an org change.
const bodies = ["change", "run", "command"];
let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountBrowserModule({
    slug: "turn-chip-browser-test",
    viewport: { width: 1440, height: 900 },
    readySelector: '[data-body="command"] .chip',
    moduleCode: `
      import '/apps/web/src/app.css';
      import { createElement as h } from 'react';
      import { createRoot } from 'react-dom/client';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { configure } from '@console/api';
      import { loadCatalog } from '@console/i18n';
      import { OrgChangeWorklistBody } from '/apps/web/src/features/org/ui/org-change-worklist.tsx';
      import { InboxCommand } from '/apps/web/src/features/org/ui/inbox-command.tsx';
      import { ApprovalRunWorklistBody } from '/apps/web/src/routes/inbox-action-approval.tsx';
      const answers = { '/api/v1/org-changes/oc-1': ${JSON.stringify(change)}, '/api/v1/approvals/run-1': ${JSON.stringify(run)}, '/api/v1/org-units': { items: [] } };
      window.fetch = async input => {
        const answer = answers[new URL(typeof input === 'string' ? input : input.url).pathname];
        return new Response(JSON.stringify(answer ?? {}), { status: answer ? 200 : 404, headers: { 'content-type': 'application/json' } });
      };
      await loadCatalog('ko');
      configure({ baseUrl: location.origin, refresh: { kind: 'cookie' }, passkeys: { get: async () => null, create: async () => null } });
      document.documentElement.dataset.experience = 'console';
      createRoot(document.getElementById('root')).render(h(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        h('main', null,
          h('section', { 'data-body': 'change' }, h(OrgChangeWorklistBody, { id: 'oc-1' })),
          h('section', { 'data-body': 'run' }, h(ApprovalRunWorklistBody, { id: 'run-1' })),
          h('section', { 'data-body': 'command' }, h(InboxCommand, { id: 'oc-1', command: 'approve' })))));
    `,
  });
}, 60_000);
afterAll(async () => {
  await mounted?.close();
});

const turnChips = (experience: string) => mounted.page.evaluate(([style, names]) => {
  const root = document.documentElement;
  if (style) root.dataset.experience = style;
  else delete root.dataset.experience;
  return names.map(name => {
    const chip = document.querySelector(`[data-body="${name}"] .chip`);
    if (!chip) return null;
    const s = getComputedStyle(chip);
    return { text: chip.textContent, tone: chip.className, fill: s.backgroundColor, border: s.borderTopColor, color: s.color, weight: s.fontWeight };
  });
}, [experience, bodies] as const);

// The style switch reaches the chip through an observer and a render, so each read waits for the expected tone.
async function settle(experience: string, tone: string) {
  await expect.poll(async () => (await turnChips(experience)).map(chip => chip?.tone), { timeout: 10_000 }).toEqual(bodies.map(() => `chip chip--${tone}`));
  return turnChips(experience);
}

test("the turn tag is the tinted accent tag in Console and keeps the info tag in the other styles", async () => {
  const [before, after] = t("orgChange.turn", { role: "|" }).split("|");
  const consoleChips = await settle("console", "accent");
  for (const chip of consoleChips) {
    expect(chip!.text!.startsWith(before!) && chip!.text!.endsWith(after!), chip!.text!).toBe(true);
    expect(chip).toMatchObject({ fill: "rgb(223, 240, 242)", border: "rgba(0, 0, 0, 0)", color: "rgb(8, 86, 96)", weight: "700" });
  }
  await settle("warm-clear", "info");
  const today = await settle("", "info");
  for (const chip of today) expect(chip).toMatchObject({ fill: "rgb(239, 246, 255)", border: "rgb(147, 197, 253)", color: "rgb(30, 64, 175)", weight: "600" });
});
