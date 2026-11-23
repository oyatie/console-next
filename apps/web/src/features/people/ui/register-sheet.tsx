// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ClipboardPaste, ListPlus, Users } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { chunk } from "../../../lib/chunk-guard";
import { phoneE164 } from "../../../lib/pure/formats";
import { modChord } from "../../../lib/pure/keys";
import { todayKst } from "../../../lib/pure/today";
import { CommandError } from "../../../lib/react/command-error";
import { useKeys } from "../../../lib/react/use-keys";
import { checklistRef, entitiesRef, orgStructureRef } from "../../../reference/entity/api";
import { entityName } from "../../../reference/entity/domain/names";
import { unitsQuery } from "../../../reference/org/api";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { commitLabel } from "../../../ui/composer/actions";
import { Composer } from "../../../ui/composer/composer";
import { Kbd } from "../../../ui/kbd/kbd";
import { ExperienceSwitch } from "../../../ui/patterns/experience-switch";
import { duplicateCandidates, numberHolder, problemOf } from "../api";
import { EMPTY, gaps, nextPerson, NO_PICK, type Draft, type DupPick } from "../domain/register";
import { placeOptions, resolvePlace, workplaceChoices } from "../domain/register-place";
import { peopleRefusal } from "../present";
import { useTrailPreview } from "./lifecycle-trail-preview";
import { RegisterFoot } from "./register-foot";
import { RegisterPerson } from "./register-person";
import { RegisterPlace } from "./register-place";
import { RegisterTerms } from "./register-terms";
import { useRegister } from "./use-register";
import { receipts, useReceipts } from "./use-register-receipts";
import s from "./register.module.css";

const RegisterDup = lazy(() => chunk(import("./register-dup")).then((m) => ({ default: m.RegisterDup })));
const RegisterToast = lazy(() => chunk(import("./register-toast")).then((m) => ({ default: m.RegisterToast })));
const RegisterConsoleFooter = lazy(() => chunk(import("./register-console-footer")).then((m) => ({ default: m.RegisterConsoleFooter })));

const focusFirst = (root: HTMLElement | null) =>
  requestAnimationFrame(() => root?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid] input, [data-invalid] button, [data-invalid] [role="radio"]')?.focus());

type RegisterSheetProps = {
  preset?: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onRehire: (id: string) => void;
};

function RegisterSheetInner({ preset, onClose, onOpen, onRehire, consoleMode }: RegisterSheetProps & { consoleMode: boolean }) {
  const [createMore, setCreateMore] = useState(false);
  const defaultNext = consoleMode ? createMore : true;
  const today = todayKst();
  const unitsQ = useQuery({ ...unitsQuery, refetchOnMount: "always" });
  const units = unitsQ.data?.items ?? [];
  const unitsRead = unitsQ.isSuccess && !unitsQ.isFetching;
  const entitiesQ = useQuery(entitiesRef);
  const rootsQ = useQuery({ ...orgStructureRef, retry: false });
  const entities = entitiesQ.data?.items ?? [];
  const roots = rootsQ.data?.entities ?? [];
  const placesRead = unitsRead && !entitiesQ.isPending && !entitiesQ.isFetching && !rootsQ.isPending && !rootsQ.isFetching;
  const setup = useQuery({ ...checklistRef, retry: false }).data?.phase === "SETUP";
  const body = useRef<HTMLDivElement>(null);
  const [d, setD] = useState<Draft>(() => ({ ...EMPTY, unitId: preset ?? "" }));
  useEffect(() => void requestAnimationFrame(() => body.current?.querySelector<HTMLElement>("input")?.focus()), []);
  const [tried, setTried] = useState(false);
  const [pick, setPick] = useState<DupPick>(NO_PICK);
  const options = placeOptions(units, roots, entities, d.where);
  const place = resolvePlace(options.find((o) => o.unit.id === d.unitId), entities, d.workplaceId);
  const beforeOpening = Boolean(d.hire && place?.opensOn && d.hire < place.opensOn);
  const g = gaps(d, phoneE164(d.phone) !== null, !place || place.branchId !== null);
  if (beforeOpening && !g.includes("hire")) g.push("hire");
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
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    if (openingRefused) reg.reset();
    setD((x) => ({ ...x, [k]: v }));
  };
  const cands = duplicateCandidates(reg.error);
  const openingRefused = problemOf(reg.error)?.code === "workplace_not_open_on_date";
  const hireRefusal = beforeOpening || openingRefused
    ? place?.opensOn ? t("register.err.beforeOpening", { site: place.site, date: fmtDate(place.opensOn) }) : t("register.err.beforeOpeningUnknown")
    : null;
  const preview = useTrailPreview(["ONBOARD"], { effective_date: d.hire || undefined });

  const queued = useRef<boolean | null>(null);
  const submit = (next: boolean) => {
    if (reg.isChecking) return reg.check();
    setTried(true);
    if (knownGaps.length > 0 || hireRefusal || reg.isPending) { focusFirst(body.current); return; }
    if (d.unitId && !placesRead) { queued.current = next; return; }
    if (cands.length === 0) { reg.mutate({ next }, { onError: (e) => duplicateCandidates(e).length > 0 && setTried(false) }); return; }
    if (pick.verdict === "same") { onOpen(cands[0]!.employee_id); return; }
    if (pick.verdict === "rehire") { onRehire(cands.find((c) => c.remedy === "rehire")!.employee_id); return; }
    if (pick.verdict !== "other" || !pick.code) { focusFirst(body.current); return; }
    reg.mutate({ next, override: { candidate_ids: cands.map((c) => c.employee_id), reason_code: pick.code, note: pick.note.trim() || undefined } });
  };
  const latest = useRef(submit);
  useLayoutEffect(() => void (latest.current = submit));
  useEffect(() => {
    if (queued.current === null || !placesRead) return;
    const next = queued.current;
    queued.current = null;
    latest.current(next);
  });
  const keySave = useRef<() => void>(() => {});
  useLayoutEffect(() => void (keySave.current = () => latest.current(defaultNext)));
  useKeys({ "registerSheet.save": () => keySave.current() }, { region: () => body.current?.closest('[role="dialog"]') });

  const scope = entities.length === 1 ? entityName(entities[0]) : t("register.scopeAll");
  const status = d.hire > today ? t("register.foot.statusFuture") : t("register.foot.statusNow");
  const incomplete: true | undefined = (cands.length > 0 && (!pick.verdict || (pick.verdict === "other" && !pick.code))) ? true : undefined;
  const hasReceipts = useReceipts().length > 0;

  return (
    <Composer
      open
      size="lg"
      kicker={<><Users size={12} aria-hidden />{t("register.kicker", { scope })}</>}
      title={t("register.title")}
      onClose={onClose}
      pending={reg.isSending}
      locked={reg.isChecking}
      notice={cands.length === 0 ? (reg.error && !openingRefused ? <CommandError error={reg.error} live="assertive" fieldLabel={(field) => field === "name" ? t("register.name") : undefined} own={(code) => (code === "employee_number_taken" && d.numberMode === "manual" && d.number.trim() ? t(`people.new.numberTaken.${numberHolder(reg.error)}`, { number: d.number.trim() }) : peopleRefusal(code))} /> : hasReceipts ? <Suspense fallback={null}><RegisterToast inline /></Suspense> : undefined) : undefined}
      consequence={<div className={s.consequence}>{hireRefusal ?? <RegisterFoot d={d} gaps={g} tried={tried} dup={cands.length > 0} place={place?.site && place.unit.kind !== "SITE" ? `${place.site} › ${place.unit.name}` : (place?.unit.name ?? "")} status={status} setup={setup} />}</div>}
      sections={preview}
      action={{ kind: "ONBOARD", mode: "apply", count: 1, continuation: "next" }}
      onSubmit={() => submit(defaultNext)}
      incomplete={incomplete}
      recovery={consoleMode ? (
        <Suspense fallback={null}>
          <RegisterConsoleFooter
            createMore={createMore}
            onCreateMore={setCreateMore}
            disabled={reg.isSending || reg.isChecking}
            incomplete={incomplete}
            onSubmit={() => submit(createMore)}
          />
        </Suspense>
      ) : undefined}
      secondary={consoleMode ? undefined : (
        <>
          <Link to="/people/import" className={buttonClass("ghost", { className: s.many })}><ClipboardPaste size={16} aria-hidden />{t("register.many")}</Link>
          <Link to="/people/run" className={buttonClass("ghost")}><ListPlus size={16} aria-hidden />{t("register.run.open")}</Link>
          <Button disabled={reg.isPending} onClick={() => submit(false)}>{commitLabel({ kind: "ONBOARD", mode: "apply", count: 1 })}<Kbd keys={modChord("⇧↵")} /></Button>
        </>
      )}
    >
      <div ref={body} className={s.form}>
        <RegisterPerson consoleMode={consoleMode} d={d} set={set} shown={shown} />
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
        <RegisterPlace consoleMode={consoleMode} d={d} set={set} units={units} options={options} workplaces={placesRead && place && !place.own ? workplaceChoices(entities) : []} shown={shown} hireLabel={d.hire ? fmtDate(d.hire) : null} hidePreview={Boolean(hireRefusal)} />
        <RegisterTerms consoleMode={consoleMode} d={d} set={set} shown={shown} today={today} tried={tried} hireRefusal={hireRefusal} />
      </div>
    </Composer>
  );
}

/**
 * registration (spec E3): a wide sheet over the roster. Nothing is preselected; the foot always says what is missing or
 * what registering does, and the primary is never dead (it moves to the first gap).
 */
export function RegisterSheet(props: RegisterSheetProps) {
  return (
    <ExperienceSwitch baseline={() => <RegisterSheetInner {...props} consoleMode={false} />}>
      {() => <RegisterSheetInner {...props} consoleMode />}
    </ExperienceSwitch>
  );
}
