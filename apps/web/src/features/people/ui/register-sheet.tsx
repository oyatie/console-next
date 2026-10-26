import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ClipboardPaste, ListPlus, Users } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { unitsQuery } from "../../../reference/org/api";
import { checklistRef, entitiesRef, orgStructureRef } from "../../../reference/entity/api";
import { CommandError } from "../../../lib/react/command-error";
import { peopleRefusal } from "../present";
import { phoneE164 } from "../../../lib/pure/formats";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Kbd } from "../../../ui/kbd/kbd";
import { Composer } from "../../../ui/composer/composer";
import { commitLabel } from "../../../ui/composer/actions";
import { duplicateCandidates, numberHolder, problemOf } from "../api";
import { EMPTY, gaps, nextPerson, NO_PICK, type Draft, type DupPick } from "../domain/register";
import { placeOptions, resolvePlace, workplaceChoices } from "../domain/register-place";
import { receipts } from "./use-register-receipts";
import { chunk } from "../../../lib/chunk-guard";
import { RegisterFoot } from "./register-foot";
import { RegisterPerson } from "./register-person";
import { RegisterPlace } from "./register-place";
import { RegisterTerms } from "./register-terms";
import { RegisterToast } from "./register-toast";
import { useTrailPreview } from "./lifecycle-trail-preview";
import { useRegister } from "./use-register";
import s from "./register.module.css";
import { entityName } from "../../../reference/entity/domain/names";

const RegisterDup = lazy(() => chunk(import("./register-dup")).then(m => ({ default: m.RegisterDup })));

/** Focus the first field still wrong, in page order, once the attempt's marks have rendered. */
const focusFirst = (root: HTMLElement | null) =>
  requestAnimationFrame(() => root?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid] input, [data-invalid] button, [data-invalid] [role="radio"]')?.focus());

/**
 * registration (spec E3): a wide sheet over the roster. Nothing is preselected; the foot always says what is missing or
 * what registering does, and the primary is never dead (it moves to the first gap). A possible duplicate stops the
 * registration until the user says who it is. "register and add next" keeps the sheet open, empty, with a receipt.
 */
export function RegisterSheet({ preset, onClose, onOpen, onRehire }: {
  preset?: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onRehire: (id: string) => void;
}) {
  const today = todayKst();
  // Read afresh on open: the headcount echo must count people added since (an import, a registration elsewhere).
  const unitsQ = useQuery({ ...unitsQuery, refetchOnMount: "always" });
  const units = unitsQ.data?.items ?? [];
  const unitsRead = unitsQ.isSuccess && !unitsQ.isFetching;
  const entitiesQ = useQuery(entitiesRef);
  const rootsQ = useQuery({ ...orgStructureRef, retry: false });
  const entities = entitiesQ.data?.items ?? [];
  const roots = rootsQ.data?.entities ?? [];
  // Where a place sits (its workplace and branch) is known only once these reads have landed; until then a press waits.
  const placesRead = unitsRead && !entitiesQ.isPending && !entitiesQ.isFetching && !rootsQ.isPending && !rootsQ.isFetching;
  const setup = useQuery({ ...checklistRef, retry: false }).data?.phase === "SETUP";
  const body = useRef<HTMLDivElement>(null);
  const [d, setD] = useState<Draft>(() => ({ ...EMPTY, unitId: preset ?? "" }));
  // The name takes focus once the sheet is open (React Aria first focuses the dialog itself).
  useEffect(() => void requestAnimationFrame(() => body.current?.querySelector<HTMLElement>("input")?.focus()), []);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    if (openingRefused) reg.reset();
    setD((x) => ({ ...x, [k]: v }));
  };
  const [tried, setTried] = useState(false);
  const [pick, setPick] = useState<DupPick>(NO_PICK);
  const options = placeOptions(units, roots, entities, d.where);
  const place = resolvePlace(options.find((o) => o.unit.id === d.unitId), entities, d.workplaceId);
  const beforeOpening = Boolean(d.hire && place?.opensOn && d.hire < place.opensOn);
  const g = gaps(d, phoneE164(d.phone) !== null, !place || place.branchId !== null);
  if (beforeOpening && !g.includes("hire")) g.push("hire");
  // What a press found missing shows at once, even while the places are still read (a gap that appears only once they land
  // moved the form under the pointer); only the workplace gap waits for them, since the place's workplace is not known yet.
  const knownGaps = g.filter((x) => placesRead || x !== "workplace");
  const shown = new Set(tried ? knownGaps : []);

  const reg = useRegister(d, place, (out, { next }) => {
    const e = out.employee;
    receipts.push({ id: e.id, name: e.name, number: e.employee_number ?? "", updatedAt: e.updated_at, undoable: setup, warnings: out.warnings });
    setPick(NO_PICK);
    setTried(false);
    if (!next) return onClose();
    setD(nextPerson(d, new Set()));
    requestAnimationFrame(() => body.current?.querySelector<HTMLElement>("input")?.focus());
  });
  const cands = duplicateCandidates(reg.error);
  const openingRefused = problemOf(reg.error)?.code === "workplace_not_open_on_date";
  const hireRefusal = beforeOpening || openingRefused
    ? place?.opensOn ? t("register.err.beforeOpening", { site: place.site, date: fmtDate(place.opensOn) }) : t("register.err.beforeOpeningUnknown")
    : null;
  const preview = useTrailPreview(["ONBOARD"], { effective_date: d.hire || undefined });

  // A press made while the places are still being read is kept and made once they land (it was a dead click: the
  // place's workplace looked missing for that moment, and was there by the time the gap would have shown).
  const queued = useRef<boolean | null>(null);
  const submit = (next: boolean) => {
    if (reg.isChecking) return reg.check();
    setTried(true);
    // Refuse known gaps before waiting: an invalid press must not submit a later, completed draft.
    if (knownGaps.length > 0 || hireRefusal || reg.isPending) return focusFirst(body.current);
    if (d.unitId && !placesRead) return void (queued.current = next);
    // A possible duplicate is a question, not an error: its choices open unmarked.
    if (cands.length === 0) return reg.mutate({ next }, { onError: (e) => duplicateCandidates(e).length > 0 && setTried(false) });
    if (pick.verdict === "same") return onOpen(cands[0]!.employee_id);
    if (pick.verdict === "rehire") return onRehire(cands.find((c) => c.remedy === "rehire")!.employee_id);
    if (pick.verdict !== "other" || !pick.code) return focusFirst(body.current);
    reg.mutate({ next, override: { candidate_ids: cands.map((c) => c.employee_id), reason_code: pick.code, note: pick.note.trim() || undefined } });
  };
  // Cmd/Ctrl+Enter registers and opens the next person; with Shift it registers and closes (spec section 3).
  const latest = useRef(submit);
  useEffect(() => void (latest.current = submit));
  useEffect(() => {
    if (queued.current === null || !placesRead) return;
    const next = queued.current;
    queued.current = null;
    latest.current(next);
  });
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !e.shiftKey || !(e.metaKey || e.ctrlKey) || e.isComposing || !body.current?.closest('[role="dialog"]')?.contains(document.activeElement)) return;
      e.preventDefault();
      latest.current(!e.shiftKey);
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, []);
  const scope = entities.length === 1 ? entityName(entities[0]) : t("register.scopeAll");
  const status = d.hire > today ? t("register.foot.statusFuture") : t("register.foot.statusNow");

  return (
    <Composer
      open
      wide
      kicker={<><Users size={12} aria-hidden />{t("register.kicker", { scope })}</>}
      title={t("register.title")}
      onClose={onClose}
      pending={reg.isSending}
      locked={reg.isChecking}
      notice={cands.length === 0 ? (reg.error && !openingRefused ? <CommandError error={reg.error} live="assertive" fieldLabel={(field) => field === "name" ? t("register.name") : undefined} own={(code) => (code === "employee_number_taken" && d.numberMode === "manual" && d.number.trim() ? t(`people.new.numberTaken.${numberHolder(reg.error)}`, { number: d.number.trim() }) : peopleRefusal(code))} /> : <RegisterToast inline />) : undefined}
      consequence={<div className={s.consequence}>{hireRefusal ?? <RegisterFoot d={d} gaps={g} tried={tried} dup={cands.length > 0} place={place?.site && place.unit.kind !== "SITE" ? `${place.site} › ${place.unit.name}` : (place?.unit.name ?? "")} status={status} setup={setup} />}</div>}
      sections={preview}
      action={{ kind: "ONBOARD", mode: "apply", count: 1, continuation: "next" }}
      onSubmit={() => { submit(true); }}
      incomplete={(cands.length > 0 && (!pick.verdict || (pick.verdict === "other" && !pick.code))) || undefined}
      secondary={
        <>
          <Link to="/people/import" className={buttonClass("ghost", { className: s.many })}><ClipboardPaste size={16} aria-hidden />{t("register.many")}</Link>
          <Link to="/people/run" className={buttonClass("ghost")}><ListPlus size={16} aria-hidden />{t("register.run.open")}</Link>
          <Button disabled={reg.isPending} onClick={() => submit(false)}>{commitLabel({ kind: "ONBOARD", mode: "apply", count: 1 })}<Kbd keys="⌘⇧↵" /></Button>
        </>
      }
    >
      <div ref={body} className={s.form}>
        <RegisterPerson d={d} set={set} shown={shown} />
        <Suspense fallback={null}>
          {cands.length > 0 && <RegisterDup
            mine={{ name: d.name.trim(), birth: d.birth, place: place ? `${place.site} › ${place.unit.name}` : "", hire: d.hire, status, number: d.numberMode === "manual" ? d.number : null }}
            candidates={cands}
            places={options}
            pick={pick}
            onPick={setPick}
            tried={tried}
          />}
        </Suspense>
        <RegisterPlace d={d} set={set} units={units} options={options} workplaces={placesRead && place && !place.own ? workplaceChoices(entities) : []} shown={shown} hireLabel={d.hire ? fmtDate(d.hire) : null} hidePreview={Boolean(hireRefusal)} />
        <RegisterTerms d={d} set={set} shown={shown} today={today} tried={tried} hireRefusal={hireRefusal} />
      </div>
    </Composer>
  );
}
