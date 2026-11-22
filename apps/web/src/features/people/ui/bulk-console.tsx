// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { t } from "@console/i18n";
import type { ReadState } from "../../../lib/react/query-view";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { commitLabel } from "../../../ui/composer/actions";
import { ReceiptReference } from "../../../ui/composer/receipt-reference";
import { Banner } from "../../../ui/banner/banner";
import { CommandError } from "../../../lib/react/command-error";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PhaseLine } from "../../../ui/page-head/phase-line";
import { WizardPattern } from "../../../ui/patterns/wizard";
import { Receipt } from "../../../ui/receipt/receipt";
import { StepLine } from "../../../ui/step-line/step-line";
import s from "./bulk-page.module.css";

type Step = { key: string; label: string; state: "done" | "current" | "waiting" };

export function BulkConsole({
  q,
  title,
  setup,
  steps,
  kindsBar,
  body,
  aside,
  consequence,
  done,
  batch,
  lost,
  busy,
  cmdError,
  refusedCount,
  action,
  retryCount,
  onRetryWithout,
  onLostCheck,
  onRescind,
  onClose,
  onSubmit,
  overlays,
}: {
  q: ReadState;
  title: string;
  setup: boolean;
  steps: readonly Step[];
  kindsBar: ReactNode;
  body: ReactNode;
  aside: ReactNode;
  consequence: ReactNode;
  done: string | null;
  batch: { id: string; count: number } | null;
  lost: boolean;
  busy: boolean;
  cmdError: unknown;
  refusedCount: number;
  action: { kind: "TRANSFER" | "PROMOTE" | "demotion" | "appointment"; mode: "apply" | "schedule"; count: number };
  retryCount: number;
  onRetryWithout: () => void;
  onLostCheck: () => void;
  onRescind: () => void;
  onClose: () => void;
  onSubmit: () => void;
  overlays?: ReactNode;
}) {
  const locked = lost || Boolean(done);
  return (
    <WizardPattern
      q={q}
      back={{ to: "/people", label: t("people.title") }}
      head={{
        title,
        crumbs: <Crumbs items={[<Link key="people" to="/people" search={{}} className={s.crumbLink}>{t("people.title")}</Link>]} current={t("bulk.page.crumb")} />,
        meta: <PhaseLine phase={setup ? "setup" : "operating"}>{t(setup ? "bulk.page.phaseSetup" : "bulk.page.phaseOp")}</PhaseLine>,
        actions: (
          <Button variant="ghost" size="sm" icon aria-label={t("composer.dismiss")} onClick={onClose}>
            <X size={16} aria-hidden />
          </Button>
        ),
      }}
      steps={<StepLine steps={[...steps]} label={t("bulk.page.steps")} />}
      notes={
        <>
          {kindsBar}
          {refusedCount > 0 && (
            <Banner
              tone="danger"
              live="assertive"
              title={t("bulk.refused.title", { count: refusedCount })}
              actions={
                <Button onClick={onRetryWithout} disabled={busy}>
                  {commitLabel({ ...action, count: retryCount })}
                </Button>
              }
            />
          )}
          {done && (
            <Receipt
              state="recorded"
              message={done}
              meta={batch && <ReceiptReference value={batch.id} />}
              actions={
                batch && (
                  <>
                    <Link className={buttonClass()} to="/people/notices/new" search={{ batch: batch.id, count: batch.count }}>
                      {t("bulk.notice.open")}
                    </Link>
                    <Button variant="ghost" onClick={onRescind}>
                      {t("bulk.rescind.open", { count: batch.count })}
                    </Button>
                  </>
                )
              }
            />
          )}
        </>
      }
      body={body}
      asideLabel={t("bulk.page.when")}
      aside={aside}
      consequence={consequence}
      notice={<CommandError error={cmdError} />}
      actions={
        done ? (
          <Button onClick={onClose}>{t("composer.dismiss")}</Button>
        ) : lost ? (
          <>
            <Button onClick={onClose}>{t("composer.dismiss")}</Button>
            <Button variant="primary" onClick={onLostCheck}>{t("bulk.lost.check")}</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>{t("composer.dismiss")}</Button>
            <Button variant="primary" disabled={busy || locked} onClick={onSubmit}>
              {commitLabel(action)}
            </Button>
          </>
        )
      }
      overlays={overlays}
      statusSegments={[
        { id: "scope", tone: "strong", content: t("bulk.page.crumb") },
        { id: "count", content: String(action.count) },
      ]}
    />
  );
}
