// SPDX-License-Identifier: LicenseRef-Proprietary
import { COPY } from "../copy";
import type { PageTab } from "../ui/page-head";

export function buildNowTabs(active: "now" | "health"): readonly PageTab[] {
  return [
    { id: "now", to: "/", label: COPY.nav.now, active: active === "now" },
    { id: "health", to: "/health", label: COPY.health.tabTitle, active: active === "health" },
  ];
}

export function buildAlertsTabs(active: "groups" | "silences" | "oncall"): readonly PageTab[] {
  return [
    { id: "groups", to: "/alerts", label: COPY.alerts.groupsTab, active: active === "groups" },
    { id: "silences", to: "/alerts/silences", label: COPY.alerts.silencesTab, active: active === "silences" },
    { id: "oncall", to: "/oncall", label: COPY.alerts.oncallTab, active: active === "oncall" },
  ];
}

export function buildRunningTabs(
  active: "components" | "jobs" | "changes" | "promote" | "actions" | "runbooks",
): readonly PageTab[] {
  return [
    { id: "components", to: "/running", label: COPY.running.componentsTab, active: active === "components" },
    { id: "jobs", to: "/running/jobs", label: COPY.running.jobsTab, active: active === "jobs" },
    { id: "changes", to: "/changes", label: COPY.running.changesTab, active: active === "changes" },
    { id: "promote", to: "/promote", label: COPY.running.promoteTab, active: active === "promote" },
    { id: "actions", to: "/actions", label: COPY.running.actionsTab, active: active === "actions" },
    { id: "runbooks", to: "/runbooks", label: COPY.running.runbooksTab, active: active === "runbooks" },
  ];
}
