import { lazy, Suspense, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import { ApiError } from "@console/api";
import { t } from "@console/i18n";
import { grantersQuery, myAccessQuery } from "../../reference/authz/api";
import { grantLines, requirementText } from "../../reference/authz/present";
import { orgStructureRef } from "../../reference/entity/api";
import { chunk } from "../chunk-guard";
import { failureText } from "../refusal";
import { Button } from "../../ui/button/button";
import { buttonClass } from "../../ui/button/button-class";
import { Card } from "../../ui/card/card";
import { EmptyState } from "../../ui/empty-state";
import { Skeleton } from "../../ui/skeleton/skeleton";
import { ReadReference } from "./read-reference";
import css from "./denied.module.css";
import type { AccessRequirement } from "../../reference/authz/domain/access";

const DeniedRequestForm = lazy(() =>
  chunk(import("./denied-request-form")).then((m) => ({ default: m.DeniedRequestForm })),
);

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

/** "request access": opens an on-demand form where reason chips and an optional note are submitted to access granters. */
function RequestAccess({ screen }: { screen: string }) {
  const [open, setOpen] = useState(false);
  if (!open) return <Button variant="primary" onClick={() => setOpen(true)}>{t("common.denied.request")}</Button>;
  return (
    <Suspense fallback={<Skeleton bones={["line", "line"]} />}>
      <DeniedRequestForm screen={screen} />
    </Suspense>
  );
}

export type ReadBack = { to: LinkProps["to"]; search?: LinkProps["search"]; label: string };

/** One route refusal; the refused page and its controls never render beside it. */
export function Denied({ screen, error, title, reason, back, need }: { screen?: string; error?: unknown; title?: string; reason?: string; back?: ReadBack; need?: AccessRequirement }) {
  const mineId = useId();
  const granters = useQuery(grantersQuery);
  const code = error instanceof ApiError ? error.code : undefined;
  const why = code === "out_of_scope" ? "common.denied.scope" : code === "scope_tenant_wide_only" ? "common.denied.tenantWide" : "common.denied.reason";
  const path = typeof window === "undefined" ? "/" : window.location.pathname;
  return (
    <div className="page"><Card label={title ?? t("common.denied.title.plain")} flush>
      <EmptyState title={title ?? (screen ? t("common.denied.title", { screen }) : t("common.denied.title.plain"))} reason={need ? requirementText(need) : null} />
      <div className={css.body}>
      <div className={css.row}>
        <Link to={back?.to ?? "/"} search={back?.search} className={buttonClass("ghost")}>{back?.label ?? t("common.denied.back")}</Link>
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
        {code && <code translate="no">{code}</code>}
      </details>
      <ReadReference error={error} />
      </div>
    </Card></div>
  );
}
