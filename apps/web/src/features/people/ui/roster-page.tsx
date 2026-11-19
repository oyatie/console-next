// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { useCan } from "../../../reference/authz/ui/use-can";
import { RosterExport } from "./roster-export";
import { RosterScreen } from "./roster-screen";
import { useRosterScreen } from "./use-roster-screen";

export function RosterPage(props: { manage: boolean; scoped?: boolean; switcher?: ReactNode; notice?: ReactNode }) {
  const screen = useRosterScreen();
  const can = useCan();
  return <RosterScreen {...props} screen={screen} actions={can("excel_download") && <RosterExport query={screen.r.query} total={screen.r.total} />} />;
}
