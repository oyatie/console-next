import { supportReferenceFromError } from "../../../lib/support-reference";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { i18n, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { useCan } from "../../../reference/authz/ui/use-can";
import { branchesQuery, ORG_READS, unitsQuery } from "../../../reference/org/api";
import { BlockedPanel } from "../../../ui/blocker/blocked-panel";
import { Button } from "../../../ui/button/button";
import { Composer } from "../../../ui/composer/composer";
import { changeCommands, changeUnitId, movedElsewhere, probed, refusalMessage, refusalOf } from "../api";
import { dissolvedName, type Names, type NextStep } from "../present";
import { ChangeScheduled } from "./change-scheduled";
import { EffectuateConsequence } from "./effectuate-consequence";
import { elsewhereNote, type Note } from "./use-note";
import css from "./org-change.module.css";

type Detail = components["schemas"]["OrgChangeDetail"];
type Apply = Extract<NextStep, { kind: "scheduled" | "awaitApply" | "settle" }>;
type Refetch = () => Promise<{ data?: Detail }>;

/**
 * A scheduled change (applied by itself on its date, movable and cancellable before it), applying a due one now, and
 * archiving a legacy settling dissolution: what each does, said before it is done.
 */
export function ChangeApply({ d, s, title, n, refetch, onNote }: { d: Detail; s: Apply; title: string; n: Names; refetch: Refetch; onNote: (note: Note) => void }) {
  if (s.kind === "awaitApply") return <p>{t("orgChange.effectuate.wait", { date: fmtDate(d.effectiveDate) })}</p>;
  if (s.kind === "scheduled") return <ChangeScheduled d={d} s={s} title={title} refetch={refetch} onNote={onNote} effectuate={<Effectuate d={d} title={title} refetch={refetch} onNote={onNote} />} />;
  return <Archive d={d} s={s} title={title} n={n} refetch={refetch} onNote={onNote} />;
}

/** A due change the schedule has not applied (yet, or it was refused): applied now, with its consequence said first. */
function Effectuate({ d, title, refetch, onNote }: { d: Detail; title: string; refetch: Refetch; onNote: (note: Note) => void }) {
  const [open, setOpen] = useState(false);
  const effectuate = useCommand({
    run: () => probed(() => changeCommands(d.id).effectuate(), refetch, (x) => x.status === "APPLIED" || x.status === "SETTLING", (x) => movedElsewhere(x, ["APPLIED", "SETTLING"])),
    invalidates: [...ORG_READS, "/api/v1/employees", "/api/v1/employment-assignments"],
    onSuccess: (other) => {
      setOpen(false);
      if (other) return onNote(elsewhereNote(other));
      const unit = changeUnitId(d);
      onNote({ message: t("orgChange.receipt.effectuated", { title, code: d.code }), actions: unit && <Link to="/org" search={{ sel: unit }}>{t("orgChange.receipt.backToOrg")}</Link> });
    },
  });
  const danger = d.kind === "DISSOLVE";
  const consequence = (id: string) => (
    <div id={id} className={css.consequence} role="note">
      <EffectuateConsequence d={d} /> {t("orgChange.effectuate.final")}
    </div>
  );
  return (
    <>
      {consequence("effectuate-consequence")}
      <p className={css.caution}>{t("orgChange.effectuate.freezeRisk")}</p>
      <div className={css.bar}>
        <Button variant={danger ? "danger" : "primary"} aria-describedby="effectuate-consequence" onClick={() => setOpen(true)}>{t("orgChange.effectuate", { title })}</Button>
      </div>
      <Composer open={open} title={t("orgChange.effectuate", { title })} onClose={() => setOpen(false)}
        pending={effectuate.isPending} tone={danger ? "danger" : "primary"} action={{ kind: "orgChange", mode: "apply" }}
        consequence={consequence("effectuate-confirm")}
        notice={refusalOf(effectuate.error, d.effectiveDate) === "frozen" ? <Frozen d={d} error={effectuate.error} /> : <CommandError error={effectuate.error} />}
        onSubmit={() => effectuate.mutate(undefined)}
      >{null}</Composer>
    </>
  );
}

/**
 * Archiving closes what was dissolved, and the server re-checks it then: the button names what still stands
 * in the way (open items, live members or sub-units, open branches) instead of returning a bare 409.
 */
function Archive({ d, s, title, n, refetch, onNote }: { d: Detail; s: Extract<Apply, { kind: "settle" }>; title: string; n: Names; refetch: Refetch; onNote: (note: Note) => void }) {
  const units = useQuery(unitsQuery);
  const branches = useQuery(branchesQuery);
  const name = dissolvedName(d, n);
  const archive = useCommand({
    run: () => probed(() => changeCommands(d.id).archive(), refetch, (x) => x.status === "ARCHIVED", (x) => movedElsewhere(x, ["ARCHIVED"])),
    invalidates: ORG_READS,
    onSuccess: (other) => onNote(other ? elsewhereNote(other) : { message: t("orgChange.receipt.archived", { title, code: d.code }) }),
  });
  const unitId = d.proposal.some((op) => op.op === "DISSOLVE_ORG_UNIT") ? changeUnitId(d) : undefined;
  const region = d.proposal.find((op) => op.op === "DEACTIVATE_REGION");
  const isBranch = d.proposal.some((op) => op.op === "DEACTIVATE_BRANCH");
  const live = units.data?.items ?? [];
  const members = live.find((u) => u.id === unitId)?.headcount ?? 0;
  const children = live.filter((u) => u.parentId === unitId && u.status === "ACTIVE").length;
  const openBranches = region ? (branches.data ?? []).filter((b) => b.region_id === region.regionId && !b.deactivated_at).length : 0;
  const list = new Intl.ListFormat(i18n.locale, { type: "conjunction" });
  const reasons = [
    s.open.length > 0 && t("orgChange.archive.items", { items: list.format(s.open.map((i) => i.label)) }),
    unitId && members > 0 && t("orgChange.archive.members", { name, count: members }),
    unitId && children > 0 && t("orgChange.archive.children", { name, count: children }),
    openBranches > 0 && t("orgChange.archive.branches", { name, count: openBranches }),
  ].filter((r): r is string => Boolean(r));
  const refusal = refusalOf(archive.error, d.effectiveDate);
  return (
    <>
      {s.open.length > 0 && <p>{t("orgChange.settling.left", { count: s.open.length })}</p>}
      {isBranch && <p className={css.caution}>{t("orgChange.archive.branchUsers")}</p>}
      {s.canArchive && <Composer layout="inline" headingLevel={3} title={t("orgChange.archive", { title })}
        action={{ kind: "orgDissolve", mode: "complete" }} tone="danger" pending={archive.isPending}
        blocked={reasons.length ? { reason: reasons.join(" · ") } : undefined}
        consequence={t("orgChange.archive.consequence", { name })}
        onSubmit={() => archive.mutate(undefined)}
      >{null}</Composer>}
      {refusal === "frozen" ? (
        <Frozen d={d} error={archive.error} />
      ) : refusal === "conflict" && isBranch ? (
        <div className="alert" role="alert">{t("orgChange.archive.branchUsers")}</div>
      ) : (
        <CommandError error={archive.error} />
      )}
    </>
  );
}

/** A payroll or accounting lock covers the effective date: who can lift it, and why the date cannot move now. */
function Frozen({ d, error }: { d: Detail; error: unknown }) {
  const can = useCan();
  return (
    <BlockedPanel domain="org" supportRef={supportReferenceFromError(error)}
      kind="lock"
      title={t("orgChange.frozen.title")}
      code="conflict"
      unblockers={[{ name: t("orgChange.frozen.who") }]}
      actions={can("period_lock_manage") ? <Link to="/people/period-locks" className="btn">{t("orgChange.frozen.open")}</Link> : null}
    >
      <p>{refusalMessage(error)}</p>
      <p>{t("orgChange.frozen.body", { date: fmtDate(d.effectiveDate) })}</p>
    </BlockedPanel>
  );
}
