// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode, RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { authzApplies, authzQuery, granted, type Feature } from "../../../reference/authz/api";
import type { ChartNode, Structure } from "../domain/model";
import { StructureScheduledLink, StructureToolbar, StructureToolButtons, StructureViewButtons } from "./structure-head-parts";
import { useStructureHeadMeta } from "./use-structure-head";
import type { Commands } from "./use-structure-commands";
import css from "./chart.module.css";

type View = "chart" | "list" | "outline";

/** What the toolbar asks of the view shown: step to a find result, fold every branch, open the inline add under a unit. */
export type ViewCommands = { find: (step: number) => void; fold: () => void; add: (parent: ChartNode) => void };

export function StructureAuthz({ children }: {
  children: (auth: { orgEdit: boolean; imports: { id: string; label: string; onAction: () => void }[] }) => ReactNode;
}) {
  const navigate = useNavigate();
  const authz = useQuery({ ...authzQuery, enabled: authzApplies() });
  const can = (f: Feature, scope?: "tenant") => authz.isPending || granted(authz.data?.capabilities, authz.isError)(f, scope);
  const orgEdit = can("org_change_draft") || can("org_change_apply");
  const imports = [
    ...(orgEdit
      ? [
          { id: "sheet", label: t("orgBulk.links.import"), onAction: () => void navigate({ to: "/org/import" }) },
          { id: "paste", label: t("orgBulk.links.paste"), onAction: () => void navigate({ to: "/org/paste" }) },
          { id: "edit", label: t("orgBulk.links.edit"), onAction: () => void navigate({ to: "/org/workplaces/edit" }) },
        ]
      : []),
    ...(can("employee_directory_manage", "tenant")
      ? [{ id: "roster", label: t("structure.import.roster"), onAction: () => void navigate({ to: "/people/import" }) }]
      : []),
  ];
  return <>{children({ orgEdit, imports })}</>;
}

/**
 * The page head: the org chart · list · outline switch, the phase, as-of date with the scheduled changes beside it (org-26), the change list and
 * history as a visible entry (org-26); the receipt of a change made from the chart sits in the chart's gutter (org-19).
 * Under it one toolbar serves every view: the date, the find, add and fold all.
 */
export function PageHead({ s, view, cmd, changeDates, loadingDates, readFailed = false, find, onFind, commands, inline }: {
  s?: Structure; view: View; cmd: Commands; changeDates?: readonly string[]; loadingDates?: boolean; readFailed?: boolean;
  /** The find's text: the chart and the outline step through its results, the list keeps the rows that match. */
  find: string; onFind: (q: string) => void; commands: RefObject<ViewCommands | null>;
  /** A unit is added in place (setup); otherwise add opens the governed sheet. */
  inline: boolean;
}) {
  const m = useStructureHeadMeta({ s, cmd, readFailed });
  return (
    <StructureAuthz>
      {({ orgEdit, imports }) => (
        <>
          <div className={`page__head ${css.head}`}>
            <StructureViewButtons view={view} nav={m.nav} />
            {(readFailed || m.phase === "operating") && (
              <p id={m.reasonId} className={css.phase} aria-hidden={!s && !readFailed || undefined} data-loading={!s && !readFailed || undefined} data-failed={readFailed || undefined}>
                {(readFailed || m.phase === "operating") && <span aria-hidden={readFailed || undefined}>{t("structure.phase.operatingChip")}</span>}
                {readFailed && <span className={css.phaseError}>{t("structure.readFailed")}</span>}
              </p>
            )}
            <span className="grow" />
            <StructureScheduledLink scheduled={m.scheduled} />
            <StructureToolButtons s={s} view={view} readFailed={readFailed} readOnly={m.readOnly} imports={imports} unavailable={m.unavailable} exporting={m.exporting} setExporting={m.setExporting} />
            {cmd.pending && <span className="sr-only" role="status">{t("structure.saving")}</span>}
          </div>
          {!m.firstRun && (
            <StructureToolbar
              today={m.today}
              value={m.value}
              q={m.q}
              nav={m.nav}
              changeDates={changeDates}
              loadingDates={loadingDates}
              unavailable={m.unavailable}
              find={find}
              onFind={onFind}
              commands={commands}
              readOnly={m.readOnly}
              orgEdit={orgEdit}
              addTo={m.addTo}
              inline={inline}
              parent={m.parent}
            />
          )}
        </>
      )}
    </StructureAuthz>
  );
}
