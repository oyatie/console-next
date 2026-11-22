// SPDX-License-Identifier: LicenseRef-Proprietary
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type {
  OpsAlertState,
  OpsHealth,
  OpsObligationKind,
  OpsObligationState,
  OpsSeverity,
} from "../lib/api";
import { ActionsScreen } from "../screens/actions-screen";
import { AlertsScreen } from "../screens/alerts-screen";
import { ChangesScreen } from "../screens/changes-screen";
import { HealthScreen } from "../screens/health-screen";
import { IncidentsScreen } from "../screens/incidents-screen";
import { JobsTab } from "../screens/jobs-tab";
import { NowScreen } from "../screens/now-screen";
import { ObligationsScreen } from "../screens/obligations-screen";
import { OncallScreen } from "../screens/oncall-screen";
import { PromoteScreen } from "../screens/promote-screen";
import { RecoveryScreen } from "../screens/recovery-screen";
import { RunbooksScreen } from "../screens/runbooks-screen";
import { RunningScreen } from "../screens/running-screen";
import { SilencesTab } from "../screens/silences-tab";
import { SourcesScreen } from "../screens/sources-screen";

export function NowRouteView() {
  return <NowScreen />;
}

export function HealthRouteView() {
  return <HealthScreen />;
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
          search: { state: next.state, severity: next.severity, component: next.component },
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
          search: { state: next.state, severity: next.severity, component: next.component },
        })
      }
    />
  );
}

export function AlertAckRouteView() {
  const { key } = useParams({ from: "/alerts/$key/ack" });
  const navigate = useNavigate();
  return (
    <AlertsScreen
      selectedKey={key}
      initialAction="ack"
      filters={{}}
      onFiltersChange={(next) =>
        void navigate({
          to: "/alerts",
          search: { state: next.state, severity: next.severity, component: next.component },
        })
      }
    />
  );
}

export function SilencesRouteView() {
  return <SilencesTab />;
}

export function SilenceDeepLinkRouteView() {
  const search = useSearch({ from: "/alerts/silence" }) as { matcher: string[] };
  return <SilencesTab initialMatchers={search.matcher} openCreate />;
}

export function OncallRouteView() {
  return <OncallScreen />;
}

export function IncidentsRouteView() {
  return <IncidentsScreen />;
}

export function IncidentDetailRouteView() {
  const { id } = useParams({ from: "/incidents/$id" });
  return <IncidentsScreen selectedId={id} />;
}

export function RunningRouteView() {
  const search = useSearch({ from: "/running" }) as { group?: string; state?: OpsHealth };
  const navigate = useNavigate({ from: "/running" });
  return (
    <RunningScreen
      filters={search}
      onFiltersChange={(next) => void navigate({ search: { group: next.group, state: next.state } })}
    />
  );
}

export function JobsRouteView() {
  return <JobsTab isPhoneOverride={undefined} />;
}

export function ChangesRouteView() {
  return <ChangesScreen />;
}

export function PromoteRouteView() {
  return <PromoteScreen />;
}

export function ActionsRouteView() {
  return <ActionsScreen />;
}

export function RunbooksRouteView() {
  const search = useSearch({ from: "/runbooks" }) as { doc?: string; anchor?: string };
  const navigate = useNavigate({ from: "/runbooks" });
  return (
    <RunbooksScreen
      docParam={search.doc}
      anchorParam={search.anchor}
      onSelectDoc={(doc, anchor) => void navigate({ search: { doc, anchor } })}
    />
  );
}

export function ObligationsRouteView() {
  const search = useSearch({ from: "/obligations" }) as {
    kind?: OpsObligationKind;
    state?: OpsObligationState;
  };
  const navigate = useNavigate({ from: "/obligations" });
  return (
    <ObligationsScreen
      filters={search}
      onFiltersChange={(next) => void navigate({ search: { kind: next.kind, state: next.state } })}
    />
  );
}

export function ObligationDetailRouteView() {
  const { id } = useParams({ from: "/obligations/$id" });
  const navigate = useNavigate();
  return (
    <ObligationsScreen
      selectedId={id}
      filters={{}}
      onFiltersChange={(next) =>
        void navigate({ to: "/obligations", search: { kind: next.kind, state: next.state } })
      }
    />
  );
}

export function RecoveryRouteView() {
  return <RecoveryScreen />;
}

export function SourcesRouteView() {
  return <SourcesScreen />;
}
