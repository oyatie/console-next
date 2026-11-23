// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import type { ReadState } from "../../../lib/react/query-view";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { commitLabel } from "../../../ui/composer/actions";
import { Composer } from "../../../ui/composer/composer";
import { ReceiptReference } from "../../../ui/composer/receipt-reference";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PhaseLine } from "../../../ui/page-head/phase-line";
import { Receipt } from "../../../ui/receipt/receipt";
import { StepLine } from "../../../ui/step-line/step-line";
import s from "./bulk-page.module.css";

type Step = { key: string; label: string; state: "done" | "current" | "waiting" };

export function BulkBaseline({
  state,
  titleText,
  setup,
  steps,
  action,
  busy,
  lost,
  done,
  batch,
  refusedCount,
  retryCount,
  cmdError,
  consequenceNode,
  kindsBar,
  whereNode,
  peopleNode,
  whenNode,
  rescindModal,
  onClose,
  onSubmit,
  onRetryWithout,
  onLostCheck,
  onRescind,
}: {
  state: ReadState;
  titleText: string;
  setup: boolean;
  steps: readonly Step[];
  action: { kind: "TRANSFER" | "PROMOTE" | "demotion" | "appointment"; mode: "apply" | "schedule"; count: number };
  busy: boolean;
  lost: boolean;
  done: string | null;
  batch: { id: string; count: number } | null;
  refusedCount: number;
  retryCount: number;
  cmdError: unknown;
  consequenceNode: ReactNode;
  kindsBar: ReactNode;
  whereNode: ReactNode;
  peopleNode: ReactNode;
  whenNode: ReactNode;
  rescindModal: ReactNode;
  onClose: () => void;
  onSubmit: () => boolean | undefined;
  onRetryWithout: () => void;
  onLostCheck: () => void;
  onRescind: () => void;
}) {
  return (
    <QueryState q={state} layout="form">
      {() => (
        <div className={s.page}>
          <Composer
            layout="page"
            commitId="bulk-commit"
            kicker={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("bulk.page.crumb")} />}
            title={titleText}
            subtitle={<><PhaseLine phase={setup ? "setup" : "operating"}>{t(setup ? "bulk.page.phaseSetup" : "bulk.page.phaseOp")}</PhaseLine><StepLine steps={[...steps]} label={t("bulk.page.steps")} /></>}
            action={action}
            onClose={onClose}
            pending={busy}
            locked={lost || Boolean(done)}
            onSubmit={onSubmit}
            recovery={done ? <Button onClick={onClose}>{t("composer.dismiss")}</Button> : lost ? <><Button onClick={onClose}>{t("composer.dismiss")}</Button><Button variant="primary" onClick={onLostCheck}>{t("bulk.lost.check")}</Button></> : undefined}
            consequence={consequenceNode}
            notice={
              <>
                {refusedCount > 0 && <Banner tone="danger" live="assertive" title={t("bulk.refused.title", { count: refusedCount })} actions={<Button onClick={onRetryWithout} disabled={busy}>{commitLabel({ ...action, count: retryCount })}</Button>} />}
                {done && <Receipt state="recorded" message={done} meta={batch && <ReceiptReference value={batch.id} />} actions={batch && <><Link className={buttonClass()} to="/people/notices/new" search={{ batch: batch.id, count: batch.count }}>{t("bulk.notice.open")}</Link><Button variant="ghost" onClick={onRescind}>{t("bulk.rescind.open", { count: batch.count })}</Button></>} />}
                <CommandError error={cmdError} />
              </>
            }
          >
            {kindsBar}
            <div className={s.cols}>
              {whereNode}
              {peopleNode}
              {whenNode}
            </div>
          </Composer>
          {rescindModal}
        </div>
      )}
    </QueryState>
  );
}
