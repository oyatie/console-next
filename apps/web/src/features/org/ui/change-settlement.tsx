import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { focusSoon } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { ORG_READS, unitsQuery } from "../../../reference/org/api";
import { useCan } from "../../../reference/authz/ui/use-can";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { changeCommands, changeUnitId, me, probed } from "../api";
import { elsewhereNote, type Note } from "./use-note";
import css from "./org-change.module.css";
import { Muted } from "../../../ui/muted/muted";

type Detail = components["schemas"]["OrgChangeDetail"];
type Item = components["schemas"]["OrgChangeSettlementItem"];
type Refetch = () => Promise<{ data?: Detail }>;

/**
 * Settlement after a dissolution is applied. Moving people is not a checkbox: its item stays unavailable while
 * the unit still has members, and says so with the fix (1.3). Every other item is recorded by a named person
 * with a note of what was done.
 */
export function ChangeSettlement({ d, refetch, onNote }: { d: Detail; refetch: Refetch; onNote: (n: Note) => void }) {
  const done = d.settlementItems.filter((i) => i.done).length;
  return (
    <section className="card panel" aria-labelledby="settlement">
      <h2 id="settlement" className="panel__title" tabIndex={-1}>{t("orgChange.settle.title", { n: done, total: d.settlementItems.length })}</h2>
      <ul className="list-plain">
        {d.settlementItems.map((it) => (
          <li key={it.id} className={css.item}>
            {it.done ? (
              <span className="row">
                <span className="grow">{it.label}</span>
                <Chip tone="ok">{t("orgChange.settle.doneBy", { name: it.doneByName ?? "—", at: fmtDateTime(it.doneAt) })}</Chip>
                {it.memo && <Muted>{it.memo}</Muted>}
              </span>
            ) : (
              <OpenItem d={d} it={it} refetch={refetch} onNote={onNote} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function OpenItem({ d, it, refetch, onNote }: { d: Detail; it: Item; refetch: Refetch; onNote: (n: Note) => void }) {
  const can = useCan();
  const [memo, setMemo] = useState("");
  const [tried, setTried] = useState(false);
  const memoRef = useRef<HTMLSpanElement>(null);
  const unitId = d.target.kind === "ORG_UNIT" ? changeUnitId(d) : undefined;
  const transfer = it.itemKey === "TRANSFER_EMPLOYEES" && !!unitId;
  const units = useQuery({ ...unitsQuery, enabled: transfer });
  const unit = units.data?.items.find((u) => u.id === unitId);
  const complete = useCommand({
    run: () =>
      probed(() => changeCommands(d.id).settle(it.id, memo.trim() || undefined), refetch, (x) => !!x.settlementItems.find((i) => i.id === it.id)?.done, (x) => {
        const now = x.settlementItems.find((i) => i.id === it.id);
        return now && now.doneBy !== me() ? { name: now.doneByName, at: now.doneAt } : undefined;
      }),
    invalidates: ORG_READS,
    onSuccess: (other) => {
      onNote(other ? elsewhereNote(other) : { message: t("orgChange.receipt.settled", { label: it.label, code: d.code }) });
      focusSoon("settlement");
    },
  });
  const label = t("orgChange.settle.complete", { label: it.label });
  if (d.status !== "SETTLING" || !can("org_change_apply"))
    return (
      <span className="row">
        <span className="grow">{it.label}</span>
        <Chip>{t("orgChange.settle.waiting")}</Chip>
      </span>
    );
  if (transfer && !units.data) return <span>{it.label}</span>;
  if (transfer) {
    const left = unit?.headcount ?? 0;
    const name = unit?.name ?? "—";
    return (
      <span className={css.fix}>
        <span className="row">
          <span className="grow">{it.label}</span>
          {left === 0 && <Link to="/org" search={{ sel: unitId }}>{t("orgChange.openUnit")}</Link>}
        </span>
        {left > 0 ? (
          <DisabledReason
            control={(p) => <Button {...p}>{label}</Button>}
            reason={t("orgChange.settle.transfer.left", { name, count: left })}
            remedy={<Link to="/org" search={{ sel: unitId, act: "reassign" }}>{t("orgChange.settle.moveMembers", { count: left })}</Link>}
          />
        ) : (
          <span className="row">
            <span className="muted grow">{t("orgChange.settle.transfer.zero", { name })}</span>
            <Button disabled={complete.isPending || !unit} onClick={() => complete.mutate(undefined)}>{label}</Button>
          </span>
        )}
        <CommandError error={complete.error} />
      </span>
    );
  }
  const missing = tried && !memo.trim();
  return (
    <span ref={memoRef} className={css.fix}>
      <Field label={t("orgChange.settle.memo", { label: it.label })} required example={t("orgChange.settle.memo.example")} error={missing ? t("orgChange.settle.memo.required") : undefined}>
        {(p) => <TextArea {...p} rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />}
      </Field>
      <span className="row">
        <span className="grow" />
        <Button
          disabled={complete.isPending}
          onClick={() => {
            setTried(true);
            if (memo.trim()) complete.mutate(undefined);
            else memoRef.current?.querySelector("textarea")?.focus();
          }}
        >
          {label}
        </Button>
      </span>
      <CommandError error={complete.error} />
    </span>
  );
}
