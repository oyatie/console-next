import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { LegalEntity, Workplace } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { codeText, labeled, RECORD_STATUS } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { RowActions } from "../../../ui/record-actions/record-actions";
import { useRecordLock } from "./use-record-lock";
import { checklistRef } from "../../../reference/entity/api";
import type { Place, StructureAct } from "../../../reference/org/domain/structure";
import { Facts, type Fact } from "../../../reference/org/ui/panel-shell";
import { OrderButtons } from "../../../reference/org/ui/order-buttons";
import { kindsQuery } from "../api";
import { addressLine, registrationOf, registrationTodo, workplaceName } from "../domain/view";
import { INFO_LABEL, kindName, withholdingText } from "../present";
import { AttachHost } from "./workplace-attach-sheet";
import { WorkplaceRegistrationChangeHost } from "./workplace-registration-change";
import { WorkplaceCodeEdit } from "./workplace-code-edit";
import { WorkplaceEdit } from "./workplace-edit";
import type { InfoKey } from "./workplace-edit-fields";
import { WorkplaceMoveSheet } from "./workplace-move-sheet";
import { WorkplaceStatusSheet } from "./workplace-status";
import { Muted } from "../../../ui/muted/muted";

type Open = { k: "info"; field: InfoKey; clear?: boolean } | { k: "move" | "status" | "attach" | "code" | "changeReg" } | { k: "kind" | "primary" };

export function WorkplaceFacts({ e, w, place, onAct, onHistory }: { e: LegalEntity; w: Workplace; place?: Place; onAct?: (a: StructureAct) => void; onHistory: () => void }) {
  const [state, setOpen] = useState<Open | null>(null);
  const navigate = useNavigate();
  // Kind and primary/head-office are structure acts: their sheets live with the org chart (one host); from the entity page the row's
  // edit opens the chart with this workplace selected and that sheet open.
  const open = state?.k === "kind" || state?.k === "primary" ? null : state;
  const structure = (act: "wp-kind" | "wp-primary") => (onAct ? onAct(act) : void navigate({ to: "/org", search: { sel: w.id, act } }));
  const kinds = useQuery(kindsQuery).data?.items;
  const setup = useQuery({ ...checklistRef, retry: false }).data?.phase === "SETUP";
  const close = () => setOpen(null);
  const c = w.current;
  // A historical view (as-of) of the legal entity page draws no verbs, like the record's own fact rows.
  const asof = useRecordLock() === "asof";
  const manage = !asof && !e.read_only && !w.read_only && w.can_manage;
  const why = w.closed_on ? t("workplace.closed.noEdit") : undefined;
  const row = (label: string, value: ReactNode, o: Open, extra?: { add?: boolean; clear?: InfoKey | false; hint?: ReactNode }): Fact => ({
    label,
    value: <>{value}{extra?.hint && <> <Muted>· {extra.hint}</Muted></>}</>,
    act: manage && (
      <RowActions
        field={label}
        edit={extra?.add ? "add" : "edit"}
        onEdit={() => (o.k === "kind" ? structure("wp-kind") : o.k === "primary" ? structure("wp-primary") : setOpen(o))}
        why={why}
        path={setup ? "setup" : "revision"}
        history={onHistory}
        end={extra?.clear && !why ? { verb: "clear", onPress: () => setOpen({ k: "info", field: extra.clear as InfoKey, clear: true }) } : undefined}
      />
    ),
  });
  const none = <Muted>{t("entityOps.info.none")}</Muted>;
  const info = (field: InfoKey, value: string | null | undefined) => row(INFO_LABEL[field](), value || none, { k: "info", field }, { clear: field !== "name" && Boolean(value) && field });
  const reg = registrationOf(e, w.registration_id);
  const filing = registrationOf(e, w.filing_registration_id);
  const primary = e.workplaces.find((x) => x.is_primary);
  const head = e.workplaces.find((x) => x.id === e.head_office_workplace_id);
  const roles = [w.is_primary && t("workplace.primary"), w.is_head_office && t("workplace.headOffice")].filter(Boolean).join(" · ");
  const st = labeled(RECORD_STATUS, c?.status ?? "CONTINUING");
  const suspended = c?.status === "SUSPENDED";
  const wh = w.withholding;
  const basis = wh.basis ? codeText(`workplace.withholding.basis.${wh.basis}`, wh.basis) : wh.remedy ? codeText(`workplace.withholding.remedy.${wh.remedy}`, wh.remedy) : null;
  const siblings = place?.entity.children.filter((x) => x.kind === "WORKPLACE") ?? [];
  const rows: (Fact | false)[] = [
    info("name", workplaceName(w)),
    row(t("workplace.create.kind"), w.kind_code ? kindName(kinds, w.kind_code) : <Muted>{t("workplace.kind.unset")}</Muted>, { k: "kind" }, { hint: t("workplace.kind.labelOnly") }),
    w.is_abstract
      ? { label: t("workplace.create.address"), value: w.not_registered_reason?.label ?? none }
      : row(t("workplace.create.address"), addressLine(c?.address) || <Muted>{t("workplace.incomplete")}</Muted>, { k: "move" }),
    row(
      t("workplace.field.status"),
      <span className="row">
        <Chip tone={st.tone}>{st.label}</Chip>
        {suspended && c?.status_since && <span className="muted num">{c.status_until ? t("entityOps.status.window", { since: fmtDate(c.status_since), until: fmtDate(c.status_until) }) : t("entityOps.status.since", { since: fmtDate(c.status_since) })}</span>}
      </span>,
      { k: "status" },
    ),
    row(t("orgStructure.wp.roles"), roles || <Muted>{t("orgStructure.wp.notRoles", { primary: primary ? workplaceName(primary) : "—", head: head ? workplaceName(head) : "—" })}</Muted>, { k: "primary" }),
    reg
      ? {
          label: t("workplace.field.regMode"),
          value: <span className="row"><span className="num">{reg.brn?.display ?? t("workplace.brnPending")}</span>{reg.holder_workplace_id === w.id && <Chip tone="ok">{t("orgStructure.wp.ownCert")}</Chip>}</span>,
          // The certificate is its own record on the legal entity page (its correction and suspension and closure live there);
          // a newly issued one is recorded from here too, where the certificate is shown (owner 2026-10-14): the link opens
          // the one certificate reissue sheet on the entity page.
          act: (
            <div className="row">
              {manage && !why && (
                <Button
                  variant="link"
                  onClick={() => setOpen({ k: "changeReg" })}
                  aria-label={t("workplace.regChange.title", { name: workplaceName(w) })}
                >
                  {t("workplace.regChange.action")}
                </Button>
              )}
              {manage && !why && !reg.closed_on && <Link to="/org/entities/$id" params={{ id: e.id }} search={{ wp: w.id, reissue: reg.id }} className="link" aria-label={t("entityReissue.actionOf", { brn: reg.brn?.display ?? "" })}>{t("entityReissue.action")}</Link>}
              {place && <Link to="/org/entities/$id" params={{ id: e.id }} className="link">{t("orgStructure.open")}</Link>}
            </div>
          ),
        }
      : registrationTodo(w)
        ? row(t("workplace.field.regMode"), t("workplace.registration.prompt"), { k: "attach" }, { add: true })
        : { label: t("workplace.field.regMode"), value: w.not_registered_reason?.label ?? none },
    !reg && {
      label: t("workplace.filing.entityBasis"),
      value: filing?.brn?.display ?? none,
    },
    row(t("workplace.field.openedOn"), <span className="num">{c?.opened_on ? fmtDate(c.opened_on) : "—"}</span>, { k: "info", field: "openedOn" }, { hint: t("entityRecord.action.cor") }),
    info("representative", c?.representative_name),
    info("product", c?.main_product),
    info("phone", c?.phone?.display),
    info("fax", c?.fax?.display),
    info("email", c?.email),
    info("mail", c?.mail_address ? addressLine(c.mail_address) : null),
    !!place && siblings.length > 1 && {
      label: t("orgStructure.order.field"),
      value: t("orgStructure.order.place", { n: siblings.findIndex((x) => x.id === place.node.id) + 1, of: siblings.length, entity: place.entity.name }),
      act: manage && !why ? <OrderButtons parent={place.entity} node={place.node} kind="WORKPLACE" /> : null,
    },
    row(t("workplace.code.field"), w.code ? <span className="num">{w.code}</span> : <Muted>{t("workplace.code.none")}</Muted>, { k: "code" }),
    {
      label: t("workplace.create.withholding"),
      value: <>{withholdingText(w.withholding)}{basis && <> <Muted>· {basis}</Muted></>}</>,
    },
  ];
  return (
    <>
      <Facts rows={rows} />
      {open?.k === "code" && <WorkplaceCodeEdit w={w} onDone={close} />}
      {open?.k === "info" && <WorkplaceEdit e={e} w={w} field={open.field} clear={open.clear} setup={setup} onClose={close} />}
      {open?.k === "move" && <WorkplaceMoveSheet e={e} w={w} onClose={close} />}
      {open?.k === "status" && <WorkplaceStatusSheet e={e} w={w} onClose={close} />}
      {open?.k === "attach" && <AttachHost entityId={e.id} workplaceId={w.id} onClose={close} />}
      {open?.k === "changeReg" && <WorkplaceRegistrationChangeHost entityId={e.id} workplaceId={w.id} onClose={close} />}
    </>
  );
}
