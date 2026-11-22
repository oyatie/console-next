// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState } from "react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Receipt } from "../../../ui/receipt/receipt";
import type { PrivacyRightKind, WirePrivacyReceipt } from "../api/privacy-intake";
import { DecisionComposer, PostponeComposer } from "./privacy-intake-composers";
import s from "./privacy-intake.module.css";

const PrivacyObjectionComposer = lazy(() =>
  import("./privacy-objection-composer").then(m => ({ default: m.PrivacyObjectionComposer })),
);

export function PrivacyIntakeWorkbench({ request }: { request: WirePrivacyReceipt }) {
  const [decideKind, setDecideKind] = useState<PrivacyRightKind | null>(null);
  const [postponeKind, setPostponeKind] = useState<PrivacyRightKind | null>(null);
  const [objectOpen, setObjectOpen] = useState(false);
  const [receiptMessage, setReceiptMessage] = useState<string | null>(null);

  const kindEntries = Object.entries(request.kinds) as [
    PrivacyRightKind,
    WirePrivacyReceipt["kinds"][string],
  ][];
  const allKinds = kindEntries.map(([code]) => code);

  return (
    <div className={s.section}>
      {receiptMessage && <Receipt state="recorded" message={receiptMessage} />}
      <Card title={t("privacy.intake.decisionsTitle")}>
        <div className={s.section}>
          {kindEntries.map(([code, state]) => {
            const hasDecision = state.decisions.length > 0;
            const latestDecision = state.decisions.at(-1)?.decision;
            const canDecide = !hasDecision || latestDecision?.outcome === "POSTPONED";
            const canPostpone = code === "ACCESS" && !hasDecision && Boolean(state.due?.on);
            return (
              <div key={code} className={s.filterBar}>
                <div className={s.actions}>
                  <strong>{t(`account.privacy.kind.${code}`)}</strong>
                  <Chip tone={latestDecision ? "ok" : "neutral"}>
                    {latestDecision
                      ? t(`account.privacy.outcome.${latestDecision.outcome}`)
                      : t("account.privacy.status.RECEIVED")}
                  </Chip>
                </div>
                <div className={s.actions}>
                  {canDecide && (
                    <Button variant="primary" onClick={() => setDecideKind(code)}>
                      {t("privacy.intake.decideOpen")}
                    </Button>
                  )}
                  {canPostpone && (
                    <Button onClick={() => setPostponeKind(code)}>
                      {t("privacy.intake.postponeOpen")}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          {request.status === "DECIDED" && allKinds.length > 0 && (
            <div className={s.actions}>
              <Button onClick={() => setObjectOpen(true)}>
                {t("privacy.intake.objectionOpen")}
              </Button>
            </div>
          )}
        </div>
      </Card>
      {decideKind && (
        <DecisionComposer
          requestId={request.id}
          kind={decideKind}
          onClose={() => setDecideKind(null)}
          onDone={msg => {
            setDecideKind(null);
            setReceiptMessage(msg);
          }}
        />
      )}
      {postponeKind && (
        <PostponeComposer
          requestId={request.id}
          kind={postponeKind}
          onClose={() => setPostponeKind(null)}
          onDone={msg => {
            setPostponeKind(null);
            setReceiptMessage(msg);
          }}
        />
      )}
      {objectOpen && (
        <Suspense fallback={null}>
          <PrivacyObjectionComposer
            requestId={request.id}
            availableKinds={allKinds}
            onClose={() => setObjectOpen(false)}
            onSubmitted={() => {
              setObjectOpen(false);
              setReceiptMessage(t("privacy.intake.objectionReceipt"));
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
