import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { unitsQuery } from "../../../reference/org/api";
import { unitPath } from "../../../reference/org/present";
import { checklistRef, entitiesRef, orgStructureRef } from "../../../reference/entity/api";
import { CommandError } from "../../../lib/react/command-error";
import { peopleRefusal } from "../present";
import { phoneE164 } from "../../../lib/pure/formats";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { Kbd } from "../../../ui/kbd/kbd";
import { parseTyped } from "../../../ui/date/days";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { PhaseLine } from "../../../ui/page-head/phase-line";
import { duplicateCandidates } from "../api";
import { birthDate, EMPTY, gaps, isCarried, nextPerson, NO_PICK, type CarryKey, type Draft, type DupPick } from "../domain/register";
import { placeOptions, resolvePlace } from "../domain/register-place";
import { placeText } from "../present";
import { receipts } from "./use-register-receipts";
import { RegisterDup } from "./register-dup";
import { RegisterToast } from "./register-toast";
import { RunCarry } from "./register-run-carry";
import { RunSide } from "./register-run-side";
import { RunTable, type RunRow } from "./register-run-table";
import { useRegister, useUndoRegister } from "./use-register";
import s from "./register-run.module.css";

/**
 * /people/run, registration in a row (spec E3-run): one row per person, typed left to right and saved with ⌘↵ straight into the
 * next row. Carry chips (all off at first) keep a value for the next people of this run. The same rules as the sheet:
 * nothing preselected, every gap named and focused, a possible duplicate stops the row until the user says who it is.
 */
export function RegisterRunPage() {
  return <AccessGate domain="hr_basic" level="edit" tenant><RegisterRun /></AccessGate>;
}

/** "A › B › unit" → "unit · A › B": the place a person goes to, readable when its cell cuts it short. */
const unitFirst = (path: string) => {
  const parts = path.split(" › ");
  return parts.length > 1 ? `${parts.at(-1)} · ${parts.slice(0, -1).join(" › ")}` : path;
};

export function RegisterRun() {
  const nav = useNavigate();
  const today = todayKst();
  const unitsQ = useQuery({ ...unitsQuery, refetchOnMount: "always" });
  const units = unitsQ.data?.items ?? [];
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const roots = useQuery({ ...orgStructureRef, retry: false }).data?.entities ?? [];
  const setup = useQuery({ ...checklistRef, retry: false }).data?.phase === "SETUP";
  // Only places a person can be registered at are offered (a unit with a registered workplace and its branch).
  const all = placeOptions(units, roots, entities, null);
  const options = all.filter((o) => resolvePlace(o, entities, "")?.branchId);
  const [d, setD] = useState<Draft>(EMPTY);
  const [from, setFrom] = useState<Draft | null>(null);
  const [hireText, setHireText] = useState("");
  const [carry, setCarry] = useState<ReadonlySet<CarryKey>>(new Set());
  const [rows, setRows] = useState<RunRow[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [tried, setTried] = useState(false);
  const [pick, setPick] = useState<DupPick>(NO_PICK);
  const [dups, setDups] = useState(0);
  const finishing = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v, ...(k === "unitId" && { where: v ? "unit" : null }) }));
  const onHire = (text: string) => {
    setHireText(text);
    const p = parseTyped(text);
    set("hire", "date" in p ? p.date : "");
  };
  const chosen = options.find((o) => o.unit.id === d.unitId);
  const place = resolvePlace(chosen, entities, "");
  const g = gaps(d, phoneE164(d.phone) !== null, true);
  const focusName = () => requestAnimationFrame(() => body.current?.querySelector<HTMLElement>('[data-run="name"]')?.focus());
  const focusFirst = () => requestAnimationFrame(() => body.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid] input')?.focus());
  const placeName = (o = chosen) => (o ? placeText(units, o) : "");

  const reg = useRegister(d, place, (out) => {
    const e = out.employee;
    receipts.push({ id: e.id, name: e.name, number: e.employee_number ?? "", updatedAt: e.updated_at, undoable: setup, warnings: out.warnings });
    setRows((rs) => [...rs, { id: e.id, n: rs.length + 1, name: e.name, birth: birthDate(d) ?? "", number: e.employee_number ?? "", type: d.type ?? "", place: chosen?.unit.name ?? "", hire: d.hire, phone: d.phone, position: d.position, pay: d.pay, updatedAt: e.updated_at, undone: false }]);
    setPick(NO_PICK);
    setTried(false);
    if (finishing.current) return void nav({ to: "/people", search: {} });
    const next = nextPerson(d, carry);
    setFrom(d);
    setD(next);
    setHireText(next.hire);
    focusName();
  });
  const undo = useUndoRegister();
  const cands = duplicateCandidates(reg.error);

  const save = (finish: boolean) => {
    finishing.current = finish;
    // An untouched entry row: finishing just leaves.
    if (finish && !d.name.trim() && !tried) return void nav({ to: "/people", search: {} });
    setTried(true);
    if (g.length > 0 || reg.isPending) return focusFirst();
    if (cands.length === 0) return reg.mutate({ next: !finish }, { onError: (e) => duplicateCandidates(e).length > 0 && (setDups((n) => n + 1), setTried(false)) });
    if (pick.verdict === "same") return void nav({ to: "/people/$id", params: { id: cands[0]!.employee_id }, search: {} });
    if (pick.verdict === "rehire") return void nav({ to: "/people/$id", params: { id: cands.find((c) => c.remedy === "rehire")!.employee_id }, search: { act: "rehire" } });
    if (pick.verdict !== "other" || !pick.code) return focusFirst();
    reg.mutate({ next: !finish, override: { candidate_ids: cands.map((c) => c.employee_id), reason_code: pick.code, note: pick.note.trim() || undefined } });
  };
  const latest = useRef(save);
  useEffect(() => void (latest.current = save));
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      e.preventDefault();
      latest.current(e.shiftKey);
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [latest]);
  // The name takes focus as the page opens.
  useEffect(() => void requestAnimationFrame(() => body.current?.querySelector<HTMLElement>('[data-run="name"]')?.focus()), [body]);

  const undoRow = (r: RunRow) => undo.mutate({ id: r.id, updatedAt: r.updatedAt }, { onSuccess: () => (receipts.drop(r.id), setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, undone: true } : x)))) });
  // the run is undone row by row (no server batch id, EMP-UI 6); a failure stops it and names what is left.
  const undoAll = async () => {
    try {
      for (const r of rows.filter((x) => !x.undone)) await undo.mutateAsync({ id: r.id, updatedAt: r.updatedAt }).then(() => (receipts.drop(r.id), setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, undone: true } : x)))));
    } catch {
      // The refusal shows under the table (undo.error); the rows not yet undone stay as they are.
    }
  };
  const live = rows.filter((r) => !r.undone);
  const shownGaps = new Set(tried ? g : []);
  const title = chosen ? t("register.run.titleAt", { place: placeName() }) : t("register.run.title");

  return (
    <div className={s.page} ref={body}>
      <PageHead
        band
        crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("register.run.crumb")} />}
        title={title}
        meta={<PhaseLine phase={setup ? "setup" : "operating"}>{t(setup ? "register.run.phaseSetup" : "register.run.phaseOp")}</PhaseLine>}
        tools={
          <>
            <span className={s.sum} role="status">
              {t("register.run.sum", { n: live.length })}
              {chosen && <> · {t("register.run.unitNow", { unit: chosen.unit.name, count: chosen.unit.headcount })}</>}
            </span>
            {live.length > 0 && <Button onClick={() => save(true)}>{t("register.run.finish")}<Kbd keys="⌘⇧↵" /></Button>}
          </>
        }
      />
      <RunCarry d={d} carry={carry} onCarry={setCarry} placeName={chosen?.unit.name ?? ""} />
      <div className={s.cols}>
        <div className={s.main}>
          <div className={s.wrap}>
            <RunTable
              rows={rows}
              showAll={showAll}
              onShowAll={() => setShowAll(true)}
              d={d}
              set={set}
              hireText={hireText}
              onHire={onHire}
              today={today}
              // The unit's own name first (what a narrow cell shows), then where it sits; the headcount is in the head.
              places={options.map((o) => ({ id: o.unit.id, text: unitFirst(entities.length > 1 ? placeText(units, o) : unitPath(units, o.unit)) }))}
              carried={(k) => isCarried(d, from, k, carry)}
              invalid={shownGaps}
              undoable={setup}
              onUndo={undoRow}
              onSave={() => save(false)}
            />
          </div>
          {tried && g.length > 0 && <p role="alert" className={s.err}>{t("register.foot.errors", { n: g.length, list: g.map((x) => t(`register.field.${x}`)).join(" · ") })}</p>}
          {cands.length > 0 && (
            <RegisterDup
              mine={{ name: d.name.trim(), birth: d.birth, place: placeName(), hire: d.hire, status: t(d.hire > today ? "register.foot.statusFuture" : "register.foot.statusNow"), number: d.numberMode === "manual" ? d.number : null }}
              candidates={cands}
              places={options}
              pick={pick}
              onPick={setPick}
              tried={tried}
            />
          )}
          {cands.length === 0 && <CommandError error={reg.error} own={peopleRefusal} />}
          <CommandError error={undo.error} />
        </div>
        <RunSide registered={live.length} errors={tried ? g.length : 0} dups={dups} setup={setup} undoing={undo.isPending} onUndoAll={() => void undoAll()} />
      </div>
      <RegisterToast />
    </div>
  );
}
