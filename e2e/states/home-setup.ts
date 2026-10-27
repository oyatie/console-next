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
    key, group, state: "todo", action: "register", can_act: true, needs: "tenant_ops", skippable: false, counts, paths: ["one", "paste", "import"], ...extra,
  });
  // The order and groups mirror the checklist contract; the web must keep this order.
  let steps = [
    step("entity", "company"),
    step("workplace", "company", { state: "blocked", remedy: "create_legal_entity" }),
    step("org", "operations", { state: "blocked", remedy: "create_workplace" }),
    step("people", "operations"), step("passkey", "operations", { count: 1 }),
    step("employees", "people", { state: "blocked", remedy: "create_workplace", skippable: true }),
    step("roles", "operations", { skippable: true }),
    step("golive", "people", { state: "blocked", remedy: "accept_terms" }),
  ];
  if (state === "mid") steps[0] = { ...steps[0]!, state: "attention", remedy: "confirm_legal_entity" };
  if (["passkey", "roles", "all-done"].includes(state)) {
    const current = state === "all-done" ? "golive" : state;
    const index = steps.findIndex(s => s.key === current);
    steps = steps.map((s, i) => ({ ...s, state: i < index ? "done" : "todo", remedy: null }));
  }
  if (state === "all-done") steps[steps.length - 1] = { ...steps.at(-1)!, state: "blocked", remedy: "accept_terms" };
  const done = steps.filter(s => s.state === "done" || s.state === "attention").length;
  return { phase: "SETUP", go_live_at: null, steps, done, total: steps.length,
    summary: { people: counts.people, placed: 0, unplaced: 0, entity_unknown: 0, progress: 99 } };
}
