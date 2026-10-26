import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import { ApiError } from "@console/api";
import { t } from "@console/i18n";
import { ACCESS_REQUEST_REASONS, grantersQuery, myAccessQuery, requestAccess, type AccessRequestReason } from "../../reference/authz/api";
import { domainText, grantLines, levelText } from "../../reference/authz/present";
import { orgStructureRef } from "../../reference/entity/api";
import { failureText } from "../refusal";
import { Banner } from "../../ui/banner/banner";
import { Button } from "../../ui/button/button";
import { buttonClass } from "../../ui/button/button-class";
import { Card } from "../../ui/card/card";
import { EmptyState } from "../../ui/empty-state";
import { ReasonField } from "../../ui/reason/reason-field";
import { reasonProblem, type Reason } from "../../ui/reason/reason";
import { ReadReference } from "./read-reference";
import { CommandError } from "./command-error";
import css from "./denied.module.css";
import { useCommand } from "./command";
import type { AccessRequirement } from "../../reference/authz/domain/access";

const REASONS = ACCESS_REQUEST_REASONS.map((code) => ({ code, label: t(`common.denied.reason.${code}`) }));

/** What this account holds today: one line per grant (role · scope · until), or that it holds nothing. */
function Mine() {
  const me = useQuery(myAccessQuery);
  // The scope's name when this account may read the tree; its kind otherwise ("entity scope"). Asked only for a scoped
  // grant, so an account holding nothing draws no second refusal here.
  const scoped = !!me.data?.entries.some((e) => e.scope.kind !== "TENANT");
  const tree = useQuery({ ...orgStructureRef, retry: false, enabled: scoped });
  // A failed read says so in the loading line's place, so the refusal never shrinks under the reader.
  if (!me.data) return <span className="muted" role={me.isPending ? "status" : undefined}>{me.isPending ? t("common.denied.mine.loading") : `${t("common.loadFailed.title")} · ${failureText(me.error)}`}</span>;
  if (me.data.is_ops) return <span>{t("common.denied.mine.ops")}</span>;
  const lines = grantLines(me.data.entries, (tree.data?.entities ?? []) as Parameters<typeof grantLines>[1]);
  if (!lines.length) return <span>{t("common.denied.mine.none")}</span>;
  return (
    <ul className="list-plain">
      {lines.map((g) => (
        <li key={g.id}>
          <strong>{g.role}</strong> · {[g.scope, g.until, g.state].filter(Boolean).join(" · ")}
          {g.caveats.length > 0 && <div className="muted">{g.caveats.join(" · ")}</div>}
        </li>
      ))}
    </ul>
  );
}

/** "request access": reason chips (Other needs words), sent as a record the holders of access management see. */
function RequestAccess({ screen }: { screen: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<Reason>({ code: null, memo: "" });
  const [tried, setTried] = useState(false);
  const send = useCommand({
    run: (r: Reason) => requestAccess({ screen, reason_code: r.code as AccessRequestReason, note: r.memo.trim() || null }),
    invalidates: ["/api/v1/access"],
    announce: () => t("common.denied.request.sent"),
  });
  if (send.data) return <Banner live="polite">{t("common.denied.request.sent")}</Banner>;
  if (!open) return <Button variant="primary" onClick={() => setOpen(true)}>{t("common.denied.request")}</Button>;
  return (
    <form
      className={css.form}
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!reasonProblem(reason, "OTHER")) send.mutate(reason);
      }}
    >
      <ReasonField label={t("common.denied.request.reason")} codes={REASONS} other="OTHER" value={reason} onChange={setReason} memoMax={500} showErrors={tried} />
      <CommandError error={send.error} />
      <div className={css.row}>
        <Button variant="primary" type="submit" disabled={send.isPending}>{t("common.denied.request.send")}</Button>
      </div>
    </form>
  );
}

export type ReadBack = { to: LinkProps["to"]; label: string };

/** One route refusal; the refused page and its controls never render beside it. */
export function Denied({ screen, error, title, reason, back, need }: { screen?: string; error?: unknown; title?: string; reason?: string; back?: ReadBack; need?: AccessRequirement }) {
  const mineId = useId();
  const granters = useQuery(grantersQuery);
  const code = error instanceof ApiError ? error.code : "access_denied";
  const why = code === "out_of_scope" ? "common.denied.scope" : code === "scope_tenant_wide_only" ? "common.denied.tenantWide" : "common.denied.reason";
  const path = typeof window === "undefined" ? "/" : window.location.pathname;
  return (
    <div className="page"><Card label={t("common.denied.title.plain")} flush>
      <EmptyState title={title ?? (screen ? t("common.denied.title", { screen }) : t("common.denied.title.plain"))} reason={need ? ("domain" in need ? [need] : need.allOf).map(r => `${domainText(r.domain)} · ${levelText(r.level)}`).join(" / ") : null} />
      <div className={css.body}>
      <div className={css.row}>
        <Link to="/account" className={buttonClass("ghost")}>{t("common.denied.myAccess")}</Link>
        <Link to={back?.to ?? "/"} className={buttonClass("ghost")}>{back?.label ?? t("common.denied.back")}</Link>
      </div>
      <section className={css.mine} aria-labelledby={mineId}>
        <strong id={mineId}>{t("common.denied.mine")}</strong>
        <Mine />
      </section>
      <span className="muted">{granters.data ? t("common.denied.granters", { count: granters.data.count, names: granters.data.names.join(", ") }) : t("common.denied.granters.unavailable")}</span>
      <RequestAccess screen={path} />
      <details>
        <summary>{t("common.denied.why")}</summary>
        <p>{reason ?? t(why)}</p>
        <ReadReference error={error} />
        {error instanceof ApiError && <code>{code}</code>}
      </details>
      </div>
    </Card></div>
  );
}
