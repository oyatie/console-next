// SPDX-License-Identifier: LicenseRef-Proprietary
import { useId, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { todayKst } from "../../../lib/pure/today";
import { get } from "../../../lib/query";
import { checklistRef } from "../../../reference/entity/api";
import type { Structure } from "../domain/model";
import type { Commands } from "./use-structure-commands";

const route = getRouteApi("/app/org");

export function useStructureHeadMeta({ s, cmd, readFailed }: { s?: Structure; cmd: Commands; readFailed: boolean }) {
  const reasonId = useId();
  const unavailable = readFailed
    ? { "aria-disabled": true as const, "aria-describedby": reasonId, onClick: (e: MouseEvent) => e.preventDefault() }
    : undefined;
  const nav = route.useNavigate();
  const q = route.useSearch();
  const today = todayKst();
  const value = q.compare_b ?? q.as_of ?? today;
  const readOnly = cmd.readOnly;
  const firstRun = s?.phase === "SETUP" && s.root.children.length === 0 && !s.readOnly;
  const selected = s?.byId.get(q.sel ?? "");
  const parent = selected?.kind === "site" ? selected : selected?.siteId ? s?.byId.get(selected.siteId) : s?.root.children[0]?.children[0];
  const addTo = selected && selected.kind !== "tenant" ? selected : s?.root.children[0]?.children[0];
  const [exporting, setExporting] = useState(false);
  const checklist = useQuery(checklistRef);
  const me = useQuery(get("/api/v1/users/me"));
  const phase = (s?.phase ?? checklist.data?.phase ?? me.data?.tenant?.phase) === "OPERATING" ? "operating" : "setup";
  const scheduled = useQuery({ ...get("/api/v1/org-changes", { params: { query: { status: ["APPROVED"], limit: 1 } } }), enabled: phase === "operating" }).data?.total ?? 0;
  return { reasonId, unavailable, nav, q, today, value, readOnly, firstRun, parent, addTo, exporting, setExporting, phase, scheduled };
}
