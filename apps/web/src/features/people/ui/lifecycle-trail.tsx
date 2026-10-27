// SPDX-License-Identifier: LicenseRef-Proprietary
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { Sheet } from "../../../ui/sheet/sheet";
import { QueryState } from "../../../lib/react/query-state";
import { lifecycleCasesQuery, lifecycleCaseQuery, lifecycleTemplateQuery, type LifecycleCase } from "../api/lifecycle-trail";

import { lifecycleTrailError, trailText, trailItemLabel, trailGroup } from "../present";

import { TrailItem, TrailCaseEnd } from "./lifecycle-trail-item";
export { ItemWindow } from "./lifecycle-trail-item";

export function TrailItems({ value, onRecord }: { value: LifecycleCase; onRecord?: (target: string) => void }) {
  return <div className="form" id={`case-${value.id}`}>
    <p>{trailText(`lifecycle.trail.kind.${value.kind}`)} · <time dateTime={value.effective_date}>{fmtDate(value.effective_date)}</time> · {trailText(`lifecycle.trail.state.${value.state}`)}</p>
    {value.linked_case_id && <LinkedCase id={value.linked_case_id} />}
    {(["documents", "filing", "payment", "access", "return"] as const).map((key) => {
      const items = value.items.filter((item) => trailGroup(item.kind) === key);
      return items.length ? <TrailGroup key={key} label={t(`lifecycle.trail.group.${key}`)}>
        <h4>{t(`lifecycle.trail.group.${key}`)}</h4>
        <ul className="list-plain">{items.map((item) => <li key={item.id} id={`item-${item.id}`} className="form">
          <TrailItem item={item} value={value} onRecord={onRecord} />
        </li>)}</ul>
      </TrailGroup> : null;
    })}
    <TrailCaseEnd value={value} />
  </div>;
}

function TrailGroup({ label, children }: { label: string; children: ReactNode }) {
  const element = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const group = element.current;
    // A live cancellation removes actions; keep the reader's place until this case is unmounted.
    if (group) group.style.minHeight = `${group.getBoundingClientRect().height}px`;
  });
  return <section ref={element} aria-label={label}>{children}</section>;
}

export function LifecycleTrail({ employeeId, eventId, caseKind, exitCaseId, onRecord }: { employeeId: string; eventId?: string; caseKind?: string; exitCaseId?: string; compact?: boolean; onRecord?: (target: string) => void }) {
  const [open, setOpen] = useState(false);
  const cases = useQuery({ ...lifecycleCasesQuery(employeeId), enabled: !exitCaseId && (!eventId || open) });
  const exit = useQuery({ ...lifecycleCaseQuery(exitCaseId ?? ""), enabled: !!exitCaseId, select: (value) => [value] });
  const q = exitCaseId ? exit : cases;
  const body = <QueryState q={q} own={lifecycleTrailError} empty={(rows) => !rows.length ? <><p>{t("lifecycle.trail.empty")}</p>{caseKind && <TemplatePreview template={caseKind} />}</> : null}>{(rows) => <>
    {rows.filter((c) => (!eventId || c.trigger_id === eventId) && (!caseKind || c.kind === caseKind) && (!exitCaseId || c.id === exitCaseId) && (!eventId || !rows.some((peer) => peer.kind === "HIRE" && peer.linked_case_id === c.id))).map((c) => <TrailItems key={c.id} value={c} onRecord={onRecord} />)}
  </>}</QueryState>;
  if (!eventId) return <section aria-label={t("lifecycle.trail.title")}><h3>{t("lifecycle.trail.title")}</h3>{body}</section>;
  return <><Button variant="ghost" onClick={() => setOpen(true)}>{t("lifecycle.trail.title")}</Button>{open && <Sheet open title={t("lifecycle.trail.title")} onClose={() => setOpen(false)} consequence={t("lifecycle.trail.shared")} actions={<Button onClick={() => setOpen(false)}>{t("uiSheet.close")}</Button>}>{body}</Sheet>}</>;
}

function TemplatePreview({ template }: { template: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ ...lifecycleTemplateQuery(template), enabled: open });
  return <details onToggle={(e) => setOpen(e.currentTarget.open)}><summary>{t("lifecycle.trail.preview")}</summary>
    {open && <QueryState q={q} own={lifecycleTrailError}>{(items) => <ul>{items.map((item) => <li key={item.item_key}>{trailItemLabel(item.label_key ?? null, item.label)}</li>)}</ul>}</QueryState>}
  </details>;
}

export function CaseSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery(lifecycleCaseQuery(id));
  return <Sheet open title={t("lifecycle.trail.title")} onClose={onClose} consequence={t("lifecycle.trail.shared")} actions={<Button onClick={onClose}>{t("uiSheet.close")}</Button>}><QueryState q={q} own={lifecycleTrailError}>{(value) => <TrailItems value={value} />}</QueryState></Sheet>;
}

export function LinkedCase({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ ...lifecycleCaseQuery(id), enabled: open });
  return <><Button variant="ghost" onClick={() => setOpen(true)}>{t("lifecycle.trail.linked")}</Button>
    {open && <Sheet open title={t("lifecycle.trail.linked")} onClose={() => setOpen(false)} consequence={t("lifecycle.trail.shared")} actions={<Button onClick={() => setOpen(false)}>{t("uiSheet.close")}</Button>}>
      <QueryState q={q} own={lifecycleTrailError}>{(value) => <TrailItems value={{ ...value, linked_case_id: null }} />}</QueryState>
    </Sheet>}
  </>;
}
