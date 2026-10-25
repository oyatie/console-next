import type { KeyboardEvent, ReactNode } from "react";
import { Check } from "lucide-react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { FORMATS } from "../../../lib/pure/formats";
import { label } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { DateInput } from "../../../ui/date/date-input";
import { TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { Kbd } from "../../../ui/kbd/kbd";
import { PathPicker, type PathOption } from "../../../ui/path-picker/path-picker";
import { Table, type Column } from "../../../ui/table";
import { EMPLOYMENT_TYPES, type CarryKey, type Draft, type EmploymentType, type Gap } from "../domain/register";
import s from "./register-run.module.css";

const TYPE = { type: "employmentType", values: EMPLOYMENT_TYPES };
/** Rows above the newest few are folded (spec E3-run folded rows). */
const SHOWN_DONE = 5;

/** One person registered in this run, as its row reads. */
export type RunRow = { id: string; n: number; name: string; birth: string; number: string; type: string; place: string; hire: string; phone: string; position: string; pay: string; updatedAt: string; undone: boolean };
type Entry = { kind: "entry" };
type Line = (RunRow & { kind: "done" }) | Entry;

type Props = {
  rows: readonly RunRow[];
  showAll: boolean;
  onShowAll: () => void;
  d: Draft;
  set: <K extends keyof Draft>(k: K, v: Draft[K]) => void;
  hireText: string;
  onHire: (text: string) => void;
  today: string;
  places: readonly PathOption[];
  carried: (k: CarryKey) => boolean;
  invalid: ReadonlySet<Gap>;
  undoable: boolean;
  onUndo: (r: RunRow) => void;
  onSave: () => void;
};

/**
 * The run's rows (spec E3-run): each person registered so far (a check mark, the employee number the server gave, undo in the setup phase), the
 * older ones folded, then the entry row the next person is typed into. Carried values carry the carried tag
 * until edited. Tab moves cell to cell; Ctrl+; puts today into the start date.
 */
export function RunTable(p: Props) {
  const n = p.rows.length + 1;
  const done = p.showAll ? p.rows : p.rows.slice(-SHOWN_DONE);
  const folded = p.rows.length - done.length;
  const lines: Line[] = [...done.map((r) => ({ ...r, kind: "done" as const })), { kind: "entry" }];
  const aria = (field: string) => t("register.run.cell", { n, field });
  const bad = (g: Gap) => p.invalid.has(g) || undefined;
  const tag = (k: CarryKey) => p.carried(k) && <span className={s.tag}>{t("register.run.carried")}</span>;
  const today = (e: KeyboardEvent) => {
    if (!e.ctrlKey || e.key !== ";") return;
    e.preventDefault();
    p.onHire(p.today);
  };
  const col = (header: string, read: (r: RunRow) => ReactNode, entry: () => ReactNode, fit = false): Column<Line> => ({
    header,
    fit,
    cell: (l) => (l.kind === "done" ? <span className={l.undone ? s.undone : undefined}>{read(l)}</span> : entry()),
  });
  const columns: Column<Line>[] = [
    { header: t("register.run.col.n"), fit: true, cell: (l) => <span className={s.n}>{l.kind === "done" ? l.n : n}</span> },
    {
      header: t("register.run.col.name"),
      cell: (l) =>
        l.kind === "done" ? (
          <span className={`${s.done} ${l.undone ? s.undone : ""}`}>{!l.undone && <Check size={14} aria-hidden />}{l.name}</span>
        ) : (
          <TextInput data-run="name" aria-label={aria(t("register.run.col.name"))} aria-invalid={bad("name")} value={p.d.name} onChange={(e) => p.set("name", e.target.value)} />
        ),
    },
    col(t("register.run.col.birth"), (r) => r.birth || "—", () => (
      <DateInput className="num" label={aria(t("register.run.col.birth"))} aria-invalid={bad("birth")} value={p.d.birth} onDraftChange={(v) => p.set("birth", v)} onChange={(v) => p.set("birth", v)} />
    )),
    col(t("register.run.col.number"), (r) => <span className="num">{r.number}</span>, () => (
      <TextInput className="num" placeholder={t("register.run.numberAuto")} aria-label={aria(t("register.run.col.number"))} value={p.d.number} onChange={(e) => (p.set("number", e.target.value), p.set("numberMode", e.target.value.trim() ? "manual" : "auto"))} />
    )),
    col(t("register.run.col.type"), (r) => (r.type ? label(TYPE, r.type) : "—"), () => (
      <span className={s.cell}>
        <SelectInput aria-label={aria(t("register.run.col.type"))} aria-invalid={bad("type")} value={p.d.type ?? ""} onChange={(e) => p.set("type", (e.target.value || null) as EmploymentType | null)}>
          <option value="">{t("register.run.typePick")}</option>
          {EMPLOYMENT_TYPES.map((v) => <option key={v} value={v}>{label(TYPE, v)}</option>)}
        </SelectInput>
        {p.d.type === "CONTRACT" && (
          <DateInput className="num" min={p.d.hire || undefined} label={aria(t("register.contractEnd"))} aria-invalid={bad("contractEnd")} value={p.d.contractEnd} onChange={(v) => p.set("contractEnd", v)} />
        )}
        {tag("type")}
      </span>
    )),
    col(t("register.run.col.place"), (r) => r.place, () => (
      <span className={s.cell}>
        <PathPicker options={p.places} value={p.d.unitId} onChange={(v) => p.set("unitId", v)} placeholder={t("register.place.unitPlaceholder")} label={aria(t("register.run.col.place"))} openLabel={t("register.place.open")} invalid={Boolean(bad("unit") || bad("where") || bad("workplace"))} />
        {tag("place")}
      </span>
    )),
    col(t("register.run.col.hire"), (r) => <span className="num">{r.hire}</span>, () => (
      <span className={s.cell}>
        <DateInput className="num" label={aria(t("register.run.col.hire"))} aria-invalid={bad("hire")} value={p.hireText} onDraftChange={p.onHire} onChange={p.onHire} onKeyDown={today} />
        {tag("hire")}
      </span>
    ), true),
    col(t("register.run.col.phone"), (r) => <span className="num">{FORMATS.phone.display(r.phone)}</span>, () => (
      <TextInput className="num" inputMode="tel" aria-label={aria(t("register.run.col.phone"))} aria-invalid={bad("phone")} value={FORMATS.phone.display(p.d.phone)} onChange={(e) => p.set("phone", e.target.value.replace(/[^\d]/g, ""))} />
    )),
    col(t("register.run.col.position"), (r) => r.position, () => (
      <span className={s.cell}>
        <TextInput aria-label={aria(t("register.run.col.position"))} aria-invalid={bad("position")} value={p.d.position} onChange={(e) => p.set("position", e.target.value)} />
        {tag("position")}
      </span>
    )),
    col(t("register.run.col.pay"), (r) => <span className="num">{fmtNumber(Number(r.pay))}</span>, () => (
      <span className={s.cell}>
        <TextInput className="num" inputMode="numeric" aria-label={aria(t("register.run.col.pay"))} aria-invalid={bad("pay")} value={p.d.pay ? fmtNumber(Number(p.d.pay)) : ""} onChange={(e) => p.set("pay", e.target.value.replace(/[^\d]/g, ""))} />
        {tag("pay")}
      </span>
    )),
    {
      header: t("register.run.col.act"),
      fit: true,
      cell: (l) =>
        l.kind === "done" ? (
          l.undone ? <span className={s.n}>{t("register.run.undone")}</span> : p.undoable ? <Button variant="ghost" aria-label={t("register.run.undoOf", { name: l.name })} onClick={() => p.onUndo(l)}>{t("register.run.undo")}</Button> : null
        ) : (
          <Button variant="primary" aria-label={t("register.run.save")} onClick={p.onSave}>{t("register.run.submit")} <Kbd keys="⌘↵" /></Button>
        ),
    },
  ];
  return (
    <>
      {/* The older rows fold into one line across the table (spec E3-run). */}
      {folded > 0 && <p className={s.folded}>{t("register.run.folded", { n: folded })} · <Button variant="ghost" onClick={p.onShowAll}>{t("register.run.showAll")}</Button></p>}
      <Table label={t("register.run.title")} rows={lines} columns={columns} rowId={(l) => (l.kind === "done" ? l.id : l.kind)} />
    </>
  );
}
