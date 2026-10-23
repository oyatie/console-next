import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { User } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { keepsKey } from "../../../lib/react/command";
import { todayKst } from "../../../lib/pure/today";
import { entitiesRef, orgStructureRef } from "../../../reference/entity/api";
import { entityNameText } from "../../../reference/entity/present";
import { useCan } from "../../../reference/authz/ui/use-can";
import { BlockedPanel } from "../../../ui/blocker/blocked-panel";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { DateField } from "../../../ui/date/date-field";
import { inBounds } from "../../../ui/date/days";
import { Receipt } from "../../../ui/receipt/receipt";
import { refusalOf, type LifecycleEvent } from "../api";
import { personalFactsQuery } from "../api/record";
import { groupMissing, groupTargets } from "../domain/group-transfer";
import { addDays } from "../domain/lifecycle";
import { applies, effectivePresets } from "../domain/presets";
import { placeOptions } from "../domain/register-place";
import { fmtDay, fmtDayShort, placeEntityText } from "../present";
import { GroupBlocked, GroupFields } from "./group-transfer-fields";
import { GroupPreview } from "./group-transfer-preview";
import { Composer } from "../../../ui/composer/composer";
import { Changed, LockedDate, Restored } from "./lifecycle-notes";
import { LifecycleRefusal } from "./lifecycle-refusal";
import { LifecycleWhy } from "./lifecycle-what";
import type { Offer, Seed } from "./person-act";
import { useLifecycleCommand } from "./use-lifecycle-command";
import { useDraft, type Draft } from "./use-lifecycle-draft";
import s from "./lifecycle.module.css";

type Detail = components["schemas"]["EmployeeDetail"];
type Unit = components["schemas"]["OrgUnitHead"];
/** The group transfer refusals with their own remedy; any other goes to the shared lifecycle refusal. */
const GROUP_CODES = ["group_transfer_same_entity", "out_of_scope", "employee_unassigned", "workplace_not_open", "org_unit_at_other_workplace"] as const;
const groupCode = (code: string | undefined): code is (typeof GROUP_CODES)[number] => (GROUP_CODES as readonly (string | undefined)[]).includes(code);

/**
 * group transfer as one action (decision #30, spec E5-group-transfer): the exit at the person's legal entity and the hire at another, recorded
 * together with the consent and the continuity choice; the person's record stays one. A date after today reserves it
 * (withdrawn until then from the history), today or earlier applies it now (rescinded from the history, never
 * corrected). Where there is no receiving legal entity or workplace the sheet says why and offers the way on.
 */
export function GroupTransferSheet({ d, events, head, units, act, offer, seed, changed, onClose, onOpen, onRecorded, onReread }: {
  d: Detail;
  events: readonly LifecycleEvent[];
  head: number;
  units: Unit[];
  act: string;
  offer: Offer;
  seed?: Seed;
  changed: boolean;
  onClose: () => void;
  onOpen: (act: string, back?: string) => void;
  onRecorded: (out: LifecycleEvent) => void;
  onReread: () => Promise<number | undefined>;
}) {
  const e = d.employee;
  const today = todayKst();
  const can = useCan();
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const roots = useQuery({ ...orgStructureRef, retry: false }).data?.entities ?? [];
  const personal = useQuery({ ...personalFactsQuery(e.id), retry: false });
  const targets = groupTargets(e.legal_entity_id, entities, placeOptions(units, roots, entities, null), !can("employee_directory_manage", "tenant"));
  const locked = seed?.mode === "edit";
  const f = useDraft(e.id, act, { date: locked ? seed!.from.effective_date : "", groupStart: personal.data?.group_service_start_date ?? "" });
  const v0 = f.draft;
  const [tried, setTried] = useState(false);
  const [pin, setPin] = useState(head);
  const [conflict, setConflict] = useState<{ id: string; date: string } | null>(null);
  const [reread, setReread] = useState(false);
  const what = useRef<HTMLDivElement>(null);
  const when = applies(v0.date, today) ?? "none";
  const b = locked ? {} : { min: offer.min, max: offer.max };
  const sameDay = when === "future" ? events.find((x) => x.state === "SCHEDULED" && x.event_type === "GROUP_TRANSFER" && x.effective_date === v0.date && x.id !== seed?.from.id) : undefined;
  const replaces = locked ? seed!.from.id : (sameDay?.id ?? (conflict?.date === v0.date ? conflict.id : undefined));
  const missing = {
    ...groupMissing(v0, when === "none" ? "" : v0.date),
    date: when === "none" || !inBounds(v0.date, b.min, b.max),
    comment: !v0.comment.trim(),
    voidCode: Boolean(replaces) && !v0.voidCode,
  };
  const count = Object.values(missing).filter(Boolean).length;
  const run = useLifecycleCommand({ employeeId: e.id, kind: "GROUP_TRANSFER", pin, replaces }, v0, (out) => {
    f.done();
    onRecorded(out);
  });
  const checking = run.isError && keepsKey(run.error);
  const set = (patch: Partial<Draft>) => {
    run.reset();
    setReread(false);
    f.set(patch);
  };
  const show = (k: keyof typeof missing) => tried && missing[k];
  const ready = targets.kind === "ready" ? targets.options : null;
  const picked = ready?.find((o) => o.unit.id === v0.unit);
  const source = entities.find((x) => x.id === e.legal_entity_id);
  const from = source ? entityNameText(source) : t("entity.name.unconfirmed");
  const to = picked ? placeEntityText(picked) : t("groupTransfer.placeholder");
  const action = t("people.lifecycle.action.GROUP_TRANSFER");
  const kicker = <><User size={12} aria-hidden />{t("lifecycle.kicker", { name: e.name, number: e.employee_number ?? "—", where: [from, e.org_unit, e.position].filter(Boolean).join(" · ") })}</>;
  if (!ready)
    return (
      <Composer action={{ kind: "GROUP_TRANSFER", mode: "apply", count: 1 }} onSubmit={() => false} locked kicker={kicker} title={t("groupTransfer.title")} onClose={onClose} consequence={null} recovery={<Button onClick={onClose}>{t("composer.dismiss")}</Button>}>
        {targets.kind !== "ready" && <GroupBlocked targets={targets} onTransfer={() => onOpen("TRANSFER")} />}
      </Composer>
    );
  const words = { name: e.name, from, to, date: when !== "none" ? fmtDay(v0.date) : "", last: when !== "none" ? fmtDay(addDays(v0.date, -1)) : "" };
  const code = run.isError && !checking ? refusalOf(run.error)?.code : undefined;
  const refusal = run.isError && !checking && (
    groupCode(code) ? (
      <BlockedPanel
        kind="route"
        title={t(`groupTransfer.refused.${code}`)}
        code={code}
        unblockers={[{ name: t("lifecycle.blocker.you") }]}
        actions={
          code === "group_transfer_same_entity" ? <Button onClick={() => onOpen("TRANSFER")}>{t("groupTransfer.sameEntity")}</Button>
          : code === "out_of_scope" ? <Link to="/account" className={buttonClass()}>{t("groupTransfer.blocked.scoped.do")}</Link>
          : code === "employee_unassigned" ? <Link to="/people/unplaced" className={buttonClass()}>{t("groupTransfer.blocked.unplaced.do")}</Link>
          : <Button onClick={() => what.current?.querySelector<HTMLElement>("input")?.focus()}>{t("groupTransfer.refused.pickAgain")}</Button>
        }
      >
        {t(`groupTransfer.refused.${code}.why`, { entity: to })}
      </BlockedPanel>
    ) : (
      <LifecycleRefusal
        error={run.error}
        kind="GROUP_TRANSFER"
        onLeave={e.status === "ON_LEAVE"}
        target={from}
        onCancelEvent={(id) => onOpen(`cancel:${id}`, act)}
        onClose={onClose}
        onFocusTarget={() => what.current?.querySelector<HTMLElement>("input")?.focus()}
        onReread={async () => {
          const now = await onReread();
          if (now !== undefined) setPin(now);
          run.reset();
          setReread(true);
        }}
        onReplace={(id, date) => {
          run.reset();
          setConflict({ id, date });
        }}
      />
    )
  );
  const presets = effectivePresets("GROUP_TRANSFER", { today, ...b }).map((p) => ({ label: t(`lifecycle.preset.${p.id}`), date: p.date }));
  const dateSlot = locked ? (
    <LockedDate date={v0.date} correcting={false} onRebook={() => onOpen(`cancel:${seed!.from.id}`)} />
  ) : (
    <DateField
      label={t("groupTransfer.date")}
      required
      today={today}
      value={v0.date}
      onChange={(date) => set({ date })}
      {...b}
      presets={presets}
      echo={when !== "none" ? t("groupTransfer.date.echo", words) : undefined}
      error={show("date") && when === "none" ? t("lifecycle.date.missing") : undefined}
      showErrors={tried}
    />
  );
  return (
    <Composer
      localDraft
      onSaveDraft={onClose}
      kicker={kicker}
      title={locked ? t("lifecycle.title.change", { name: e.name, action }) : t("groupTransfer.title")}
      onClose={onClose}
      pending={run.isSending}
      locked={checking}
      notice={
        <>
          {(changed || reread) && <Changed reread={reread} />}
          {checking && <Receipt state="checking" message={t("lifecycle.checking")} />}
          {refusal}
        </>
      }
      consequence={<><GroupPreview from={from} to={to} place={picked ? picked.site : ""} date={when === "none" ? "" : v0.date} v={v0} /><p>{[t(`groupTransfer.consequence.${when}`, words), replaces && t("lifecycle.replaces", { date: fmtDayShort(v0.date), action })].filter(Boolean).join(" · ")}</p></>}
      action={{ kind: "GROUP_TRANSFER", mode: locked ? "change" : when === "future" || when === "none" ? "schedule" : "apply", count: 1 }}
      tone={locked || when === "future" || when === "none" ? "primary" : "danger"}
      missing={tried ? count : 0}
      recovery={
        checking ? (
          <>
            <Button onClick={onClose}>{t("composer.dismiss")}</Button>
            <Button variant="primary" onClick={() => run.check()}>{t("lifecycle.checking.ask")}</Button>
          </>
        ) : undefined
      }
      onSubmit={() => {
        setTried(true);
        if (count > 0) return false;
        run.mutate(undefined);
      }}
    >
      {f.restored && <Restored onClear={f.clear} />}
      <div ref={what} className={s.block}>
        <GroupFields
          v={v0}
          set={set}
          options={ready}
          units={units}
          today={today}
          show={show}
          onTransfer={() => onOpen("TRANSFER")}
          dateSlot={dateSlot}
          hire={e.hire_date ?? undefined}
          date={when === "none" ? "" : v0.date}
        />
      </div>
      <LifecycleWhy kind="GROUP_TRANSFER" v={v0} set={set} demotion={false} replaces={Boolean(replaces)} correcting={false} voidNote={false} show={(k) => tried && Boolean(missing[k as keyof typeof missing])} />
    </Composer>
  );
}
