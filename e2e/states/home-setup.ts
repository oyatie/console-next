// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api";
import { screens } from "./registry";

type Checklist = components["schemas"]["SetupChecklist"];
type Step = components["schemas"]["SetupStep"];
export const homeSetupScreen = screens[0];
export const homeSetupCases = [
  { state: "first", registry: "home--setup-phase-first-landing-after-enrolment" },
  { state: "mid", registry: "home--setup-rail-populated" },
  { state: "passkey", registry: "home--setup-phase-after-passkey-sign-in" },
  { state: "blocked-3", registry: "home--setup-rail-populated" },
  { state: "blocked-7", registry: "home--setup-rail-populated" },
  { state: "preview-unavailable", registry: "home--setup-rail-populated" },
  { state: "preview-refused", registry: "home--setup-rail-populated" },
  { state: "ready", registry: "home--setup-rail-populated" },
  { state: "roles", registry: "home--setup-rail-populated" },
  { state: "all-done", registry: "home--setup-phase-setup-rail-entity-workplace-org-people-employees" },
  { state: "loading", registry: "home--setup-rail-populated" },
  { state: "failed", registry: "home--setup-rail-populated" },
  { state: "refused", registry: "home--setup-rail-populated" },
  { state: "long", registry: "home--setup-rail-populated" },
] as const;
type HomeSetupState = (typeof homeSetupCases)[number]["state"];

export function homeSetupChecklist(state: HomeSetupState): Checklist {
  const counts = { entities: state === "first" ? 0 : 1, workplaces: 0, units: 0, people: state === "long" ? 2000 : 0, unplaced: 0, entity_unknown: 0 };
  const step = (key: string, group: Step["group"], extra: Partial<Step> = {}): Step => ({
    key, group, state: "todo", action: ({ entity: "register_legal_entity", workplace: "create_primary_workplace", org: "add_department", employees: "register_employee", roles: "add_role", golive: "open_go_live_preview" } as Record<string, string>)[key] ?? "register", can_act: true, needs: "tenant_ops", skippable: false, counts, paths: ["one", "paste", "import"], ...extra,
  });
  // The order and groups mirror the checklist contract; the web must keep this order.
  let steps = [
    step("entity", "company"),
    step("workplace", "company", { state: "blocked", remedy: "create_legal_entity" }),
    step("org", "operations", { state: "blocked", remedy: "create_workplace" }),
    step("approval", "operations", { state: "done", remedy: "invite_executive" }),
    step("people", "operations"), step("passkey", "operations", { count: 1 }),
    step("employees", "people", { state: "blocked", remedy: "create_workplace", skippable: true }),
    step("roles", "operations", { skippable: true }),
    step("golive", "people", { state: "blocked", remedy: "accept_terms" }),
  ];
  if (state === "mid") steps = steps.map((s, i) => i < 2 ? { ...s, state: "done", remedy: null } : i === 2 ? { ...s, state: "todo", remedy: null } : s);
  if (["passkey", "roles", "all-done", "ready", "blocked-3", "blocked-7", "preview-refused", "preview-unavailable"].includes(state)) {
    const current = ["passkey", "roles"].includes(state) ? state : "golive";
    const index = steps.findIndex(s => s.key === current);
    steps = steps.map((s, i) => ({ ...s, state: i < index ? "done" : "todo", remedy: null }));
  }
  if (state !== "ready") steps[steps.length - 1] = { ...steps.at(-1)!, state: "blocked", remedy: "accept_terms", count: state === "blocked-7" ? 7 : 3, can_act: state !== "preview-unavailable" };
  const done = steps.filter(s => s.state === "done" || s.state === "attention").length;
  return { phase: "SETUP", go_live_at: null, steps, done, total: steps.length,
    summary: { people: counts.people, placed: 0, unplaced: 0, entity_unknown: 0, progress: 99 } };
}
