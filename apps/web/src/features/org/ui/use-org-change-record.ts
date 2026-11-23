// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement, useEffect, useRef, useState } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { focusSoon } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { todayKst } from "../../../lib/pure/today";
import type { useCan } from "../../../reference/authz/ui/use-can";
import { changeCommands, changeUnitId, me } from "../api";
import { changeRail, changeTitle, nextStep, submittedText, type Names } from "../present";
import { useNote } from "./use-note";
import { useOrgRouted } from "./use-org-routed";

type Detail = components["schemas"]["OrgChangeDetail"];
const route = getRouteApi("/app/org/changes/$id");

export function useOrgChangeRecord(d: Detail | undefined, n: Names, can: ReturnType<typeof useCan>) {
  const today = todayKst();
  const routed = useOrgRouted();
  const { note, show, clear } = useNote();
  const { unsent, done } = route.useSearch();
  const navigate = route.useNavigate();
  const [editing, setEditing] = useState(false);
  const editable = Boolean(d && (d.status === "DRAFT" || d.status === "PRECHECKED"));
  const preflight = useCommand({ run: () => changeCommands(d!.id).preflight() });
  const checked = useRef<string>(undefined);
  const updatedAt = d?.updatedAt;
  useEffect(() => {
    if (!editable || !updatedAt || preflight.isPending || checked.current === updatedAt) return;
    checked.current = updatedAt;
    preflight.mutate(undefined);
  }, [editable, updatedAt, preflight]);

  const detailId = d?.id;
  useEffect(() => {
    if (detailId) return focusSoon("change-title");
  }, [detailId]);

  const title = d ? changeTitle(d, n) : t("structure.tab.changes");
  useEffect(() => {
    if (!done || !d) return;
    const unit = changeUnitId(d);
    const message =
      done === "submitted" ? submittedText(d, title, routed, today)
      : done === "redrafted" ? t("orgChange.receipt.redrafted", { code: d.code })
      : t("orgChange.receipt.drafted", { code: d.code });
    show({
      message,
      actions: unit ? createElement(Link, { to: "/org", search: { sel: unit } as never }, t("orgChange.receipt.backToOrg")) : undefined,
    });
    void navigate({ search: (x) => ({ ...x, done: undefined }), replace: true });
  }, [done, d, title, show, navigate, routed, today]);

  const report = editable ? (preflight.data?.preflight ?? d?.preflight) : undefined;
  const leftDraft = editing && !editable;
  const rail = d ? changeRail(d) : undefined;
  const unit = d ? changeUnitId(d) : undefined;
  const place = unit ? { sel: unit } : undefined;
  const s = d ? nextStep(d, { me: me(), can, today, routed }) : undefined;

  return {
    today,
    title,
    s,
    note,
    show,
    clear,
    unsent,
    editable,
    editing,
    setEditing,
    preflight,
    report,
    leftDraft,
    rail,
    place,
  };
}
