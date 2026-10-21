import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { entitiesRef } from "../../../reference/entity/api";
import { EntityName } from "../../../reference/entity/ui/entity-name";
import { unitsQuery } from "../../../reference/org/api";
import { unitPath } from "../../../reference/org/present";
import { Chip } from "../../../ui/chip";
import { Table } from "../../../ui/table";
import { Card } from "../../../ui/card/card";
import type { ImportDryRun } from "../domain/contract";
import { heldAnswer } from "../domain/review";
import type { Picks } from "../domain/steps";
import { valueGroups, type ValueRow } from "../domain/values";
import { choiceLabel, decisionLabel } from "../present";
import { ReviewResolve } from "./review-resolve";

/**
 * Value links (spec E7-values): per kind of value, every text in the file with its rows, where it goes in the console and
 * why — still to choose, chosen now, or remembered from an earlier import. Choosing a row opens its answer under that
 * table (the same control the queue uses); answering runs the dry run again.
 * plain tables (every text drawn); a LongTable per kind if a file brings thousands of distinct texts.
 */
export function ValueTable({ dry, picks, busy, sel, onSel, onResolve, onSheets }: {
  dry: ImportDryRun;
  picks: Picks;
  busy: boolean;
  sel: string | null;
  onSel: (id: string) => void;
  onResolve: (c: Picks) => void;
  onSheets: () => void;
}) {
  const units = useQuery(unitsQuery).data?.items ?? [];
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const groups = valueGroups(dry);
  if (groups.length === 0) return null;
  // The answer that will go with the next dry run: the operator's, else the one memory filled in.
  const answer = (r: ValueRow) => {
    const d = r.item.resolution!.decision;
    const v = heldAnswer(picks, r.item) ?? (dry.decisions[d as keyof typeof dry.decisions] as Record<string, unknown> | undefined)?.[r.item.resolution!.key] ?? r.auto;
    if (v === undefined) return null;
    if (v === null) return t(d === "unit_map" || d === "workplace_map" ? "importValues.unplaced" : "importValues.empty");
    if (typeof v !== "string") return "—";
    if (d === "unit_map") {
      const u = units.find((x) => x.id === v);
      return u ? unitPath(units, u) : "—";
    }
    if (d === "workplace_map") return entities.flatMap((e) => e.workplaces).find((w) => w.id === v)?.current?.name ?? "—";
    if (d === "company_map") {
      const e = entities.find((candidate) => candidate.workplaces.some((w) => w.id === v));
      return e ? <EntityName entity={e} /> : "—";
    }
    return choiceLabel(d, v);
  };
  const why = (r: ValueRow) =>
    heldAnswer(picks, r.item) != null ? <Chip tone="info">{t("importValues.why.chosen")}</Chip>
    : r.remembered ? <Chip tone="info">{t("importValues.why.remembered")}</Chip>
    : r.auto ? <Chip tone="ok">{t("importValues.why.auto")}</Chip>
    : <Chip tone={r.item.blocking ? "danger" : "warn"}>{t(r.item.blocking ? "importValues.why.blocking" : "importValues.why.open")}</Chip>;
  return (
    <>
      {groups.map((g) => {
        const title = t("importValues.title", { kind: decisionLabel(g.decision) });
        const open = g.rows.find((r) => r.item.id === sel);
        return (
          <Card key={g.decision} titleId={`import-values-${g.decision}`} title={title} meta={t("importValues.counts", { all: g.rows.length, open: g.open })}>
            <Table<ValueRow>
              label={title}
              rows={g.rows}
              rowId={(r) => r.item.id}
              selected={sel ?? undefined}
              onSelect={onSel}
              columns={[
                { header: t("importValues.col.text"), cell: (r) => <b>{(r.item.value ?? r.item.resolution!.key) || t("import.rows.blank")}</b> },
                { header: t("importValues.col.rows"), cell: (r) => <span className="num">{r.remembered ? "—" : r.item.rows}</span>, fit: true },
                { header: t("importValues.col.place"), cell: (r) => answer(r) ?? <span className="muted">{t("importValues.none")}</span> },
                { header: t("importValues.col.why"), cell: why, fit: true },
              ]}
            />
            {open && <ReviewResolve key={open.item.id} item={open.item} dry={dry} picks={picks} busy={busy} onResolve={onResolve} onSheets={onSheets} />}
          </Card>
        );
      })}
    </>
  );
}
