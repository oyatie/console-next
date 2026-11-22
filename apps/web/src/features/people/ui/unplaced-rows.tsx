import { Check } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { LongTable } from "../../../ui/long-table/long-table";
import { label } from "../../../lib/labels";
import { EMPLOYMENT_TYPES } from "../domain/register";
import type { Group, Person } from "../domain/unplaced";
import { sourceText } from "../present";
import s from "./unplaced.module.css";
import c from "./unplaced-console.module.css";

type Employee = components["schemas"]["Employee"];
const TYPE = { type: "employmentType", values: EMPLOYMENT_TYPES };

/**
 * The middle pane (spec E8): the current group's people to pick (several with Shift+↓ or X, all at once, or one
 * alone by pressing the row), and the groups already placed in this visit, folded, with where each person went.
 */
export function UnplacedRows({ group, sel, onSel, done, consoleMode = false }: {
  group: Group | undefined;
  sel: ReadonlySet<string>;
  onSel: (s: ReadonlySet<string>) => void;
  done: readonly { value: string; count: number; place: string; people: { e: Employee; place: string }[] }[];
  consoleMode?: boolean;
}) {
  const people = group?.people ?? [];
  return (
    <section className={s.rows} aria-label={group ? t("unplaced.groupHead", { value: sourceText(group.value), n: people.length }) : undefined}>
      <div className={s.rowsHead}>
        <b>{group ? t("unplaced.groupHead", { value: sourceText(group.value), n: people.length }) : ""}</b>
        <span className={s.sub}>{t("unplaced.picked", { n: sel.size })} · {t("unplaced.keysRow")}</span>
        <span className={s.grow} />
        {people.length > 0 && <Button variant="ghost" className={consoleMode ? c.nowrap : undefined} onClick={() => onSel(new Set(people.map((e) => e.id)))}>{t("unplaced.selectAll", { n: people.length })}</Button>}
      </div>
      <LongTable<Person>
        label={t("unplaced.title")}
        rows={people}
        rowId={(e) => e.id}
        hasMore={false}
        onLoadMore={() => undefined}
        empty={t("unplaced.empty.title")}
        mobileLayout={consoleMode ? "compact" : "cards"}
        // Pressing a row (not its box) places that person alone: only they are picked.
        onRowAction={(id) => onSel(new Set([id]))}
        selection={{ kind: "ids", ids: sel }}
        onSelectionChange={(x) => onSel(x.kind === "ids" ? x.ids : new Set(people.map((e) => e.id)))}
        columns={[
          { id: "number", header: t("unplaced.col.number"), cell: (e) => <span className="num">{e.employee_number ?? "—"}</span>, width: 84 },
          { id: "name", header: t("unplaced.col.name"), cell: (e) => <b>{e.name}</b>, rowHeader: true, width: 88 },
          { id: "reason", header: t("unplaced.col.reason"), cell: (e) => t(e.reason === "unit_unknown" ? "setup.fix.assign_departments" : "home.inbox.reason.unplaced"), width: "1fr" },
          { id: "position", header: t("unplaced.col.position"), cell: (e) => e.position ?? "—", width: 72 },
          { id: "type", header: t("unplaced.col.type"), cell: (e) => (e.employment_type ? label(TYPE, e.employment_type) : "—"), width: 88 },
          { id: "hire", header: t("unplaced.col.hire"), cell: (e) => <span className="num">{e.hire_date ? fmtDate(e.hire_date) : "—"}</span>, width: 112 },
          { id: "alone", header: <span className="sr-only">{t("unplaced.alone")}</span>, cell: () => <span className={consoleMode ? c.alone : s.alone} aria-hidden>{t("unplaced.alone")}</span>, width: 84 },
        ]}
      />
      {done.map((d) => (
        <div key={d.value} className={s.doneBlock}>
          <span className={s.doneHead}>{t("unplaced.doneGroup", { value: sourceText(d.value), n: d.count })}</span>
          {d.people.slice(0, 3).map(({ e, place }) => (
            <div key={e.id} className={s.doneRow}>
              <span className="num">{e.employee_number}</span>
              <s>{e.name}</s>
              <span className={s.ok}><Check size={12} aria-hidden />{t("unplaced.placedTo", { place })}</span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
