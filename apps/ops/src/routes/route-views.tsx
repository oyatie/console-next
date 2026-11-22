// SPDX-License-Identifier: LicenseRef-Proprietary
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { OpsAlertState, OpsHealth, OpsSeverity } from "../lib/api";
import { AlertsScreen } from "../screens/alerts-screen";
import { NowScreen } from "../screens/now-screen";
import { RunningScreen } from "../screens/running-screen";
import { SilencesTab } from "../screens/silences-tab";
import { JobsTab } from "../screens/jobs-tab";
import { SourcesScreen } from "../screens/sources-screen";

export function NowRouteView() {
  return <NowScreen />;
}

export function AlertsRouteView() {
  const search = useSearch({ from: "/alerts" }) as {
    state?: OpsAlertState;
    severity?: OpsSeverity;
    component?: string;
  };
  const navigate = useNavigate({ from: "/alerts" });
  return (
    <AlertsScreen
      filters={search}
      onFiltersChange={(next) =>
        void navigate({
          search: {
            state: next.state,
            severity: next.severity,
            component: next.component,
          },
        })
      }
    />
  );
}

export function AlertDetailRouteView() {
  const { key } = useParams({ from: "/alerts/$key" });
  const navigate = useNavigate();
  return (
    <AlertsScreen
      selectedKey={key}
      filters={{}}
      onFiltersChange={(next) =>
        void navigate({
          to: "/alerts",
          search: {
            state: next.state,
            severity: next.severity,
            component: next.component,
          },
        })
      }
    />
  );
}

export function SilencesRouteView() {
  return <SilencesTab />;
}

export function RunningRouteView() {
  const search = useSearch({ from: "/running" }) as {
    group?: string;
    state?: OpsHealth;
  };
  const navigate = useNavigate({ from: "/running" });
  return (
    <RunningScreen
      filters={search}
      onFiltersChange={(next) =>
        void navigate({
          search: {
            group: next.group,
            state: next.state,
          },
        })
      }
    />
  );
}

export function JobsRouteView() {
  return <JobsTab />;
}

export function SourcesRouteView() {
  return <SourcesScreen />;
}
