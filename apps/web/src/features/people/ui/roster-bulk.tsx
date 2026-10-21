import { useEffect, useRef, useState } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { selectionCount, type Selection } from "../../../ui/long-table/selection";
import { CommandError } from "../../../lib/react/command-error";
import { useNavigate } from "@tanstack/react-router";
import { bulkSelection } from "./use-bulk-selection";
import { BulkExitSheet } from "./bulk-exit-sheet";
import { BULK_MAX, useMatching } from "./use-roster";
import s from "./roster.module.css";

type Employee = components["schemas"]["Employee"];
/** What the selection bar opens: a bulk workspace, or the bulk exit sheet (CRUD). */
type Act = "/people/bulk" | "/people/grid" | "/people/renew" | "exit";

/**
 * The selection bar's actions: open the bulk assignment workspace or the bulk exit (CRUD: one report each, as one by
 * one) for the selected people (never more than one command takes), and drop picked people the current list no longer shows. A select-all-matching selection becomes ids
 * (one read of the filter, exclusions dropped) when the dialog opens, so its count and names are seen before commit.
 */
export function RosterBulk({ sel, rows, total, query, onClear }: {
  sel: Selection;
  rows: Employee[];
  total?: number;
  query: object;
  onClear: (s: Selection) => void;
  /** The roster's receipt hook; the workspace now records the batch and shows its own receipt. */
  onDone?: (message: string, batch: { id: string; count: number }) => void;
}) {
  // Names of everyone picked, from every page seen: a picked row may leave the list when the filter changes.
  const names = useRef(new Map<string, string>());
  useEffect(() => rows.forEach((e) => names.current.set(e.id, e.name)), [rows]);
  const [resolving, setResolving] = useState(false);
  // The same picked set opens the bulk appointment workspace or the bulk exit sheet.
  const [mode, setMode] = useState<Act>("/people/bulk");
  const [exiting, setExiting] = useState<Map<string, string> | null>(null);
  const matching = useMatching(query, total, resolving && sel.kind === "all");
  const excluded = sel.kind === "all" ? sel.excluded : null;
  const resolved = resolving && excluded && matching.data ? new Map(matching.data.items.filter((e) => !excluded.has(e.id)).map((e) => [e.id, e.name])) : null;
  // The resolved set counts too: people may have joined the filter since its total was read.
  const count = Math.max(selectionCount(sel, total ?? 0), resolved?.size ?? 0);
  const tooMany = count > BULK_MAX;
  const navigate = useNavigate();
  // The picked people go to the bulk workspace (spec E6-move); a select-all is resolved to ids first.
  const toWorkspace = (m: ReadonlyMap<string, string>, where: Exclude<Act, "exit">) => {
    bulkSelection.set(m);
    void navigate({ to: where });
  };
  const open = (m: Map<string, string>, act: Act) => (act === "exit" ? setExiting(m) : toWorkspace(m, act));
  const openDialog = (act: Act = "/people/bulk") => {
    setMode(act);
    if (sel.kind === "all") return setResolving(true);
    open(new Map([...sel.ids].map((id) => [id, names.current.get(id) ?? ""])), act);
  };
  useEffect(() => {
    if (resolved && !tooMany && mode !== "exit") toWorkspace(resolved, mode);
  });
  // A resolved select-all opens the exit sheet on render, not from an effect.
  const exitFor = exiting ?? (mode === "exit" && !tooMany ? resolved : null);
  const closeExit = () => (setExiting(null), setResolving(false), setMode("/people/bulk"));
  const shown = sel.kind === "ids" ? rows.filter((e) => sel.ids.has(e.id)).map((e) => e.id) : [];
  const hidden = sel.kind === "ids" ? sel.ids.size - shown.length : 0;
  return (
    <>
      {hidden > 0 && (
        <span className={s.inView}>
          {t("roster.selection.inView", { count: shown.length })}{" "}
          <Button variant="ghost" onClick={() => onClear({ kind: "ids", ids: new Set(shown) })}>{t("roster.selection.dropHidden", { count: hidden })}</Button>
        </span>
      )}
      {tooMany ? (
        <DisabledReason layout="inline" reason={t("roster.bulk.tooMany", { max: BULK_MAX })} control={(d) => <Button variant="primary" {...d}>{t("people.bulk.open", { count })}</Button>} />
      ) : (
        <>
          <Button id="crud-roster-bulk-exit" aria-disabled={(resolving && !resolved) || undefined} onClick={() => openDialog("exit")}>{t("crud.bulkExit.open", { count })}</Button>
          <Button aria-disabled={(resolving && !resolved) || undefined} onClick={() => openDialog("/people/renew")}>{t("renew.open", { count })}</Button>
          <Button aria-disabled={(resolving && !resolved) || undefined} onClick={() => openDialog("/people/grid")}>{t("bulkGrid.open", { count })}</Button>
        </>
      )}
      {!tooMany && (
        <Button variant="primary" aria-disabled={(resolving && !resolved) || undefined} onClick={() => openDialog()}>
          {resolving && !resolved && !matching.isError ? t("roster.bulk.resolving") : t("people.bulk.open", { count })}
        </Button>
      )}
      {resolving && matching.isError && <CommandError error={matching.error} />}
      {exitFor && <BulkExitSheet picked={exitFor} onClose={closeExit} />}
    </>
  );
}
