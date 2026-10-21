import { useState } from "react";
import { t } from "@console/i18n";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { todayKst } from "../../../lib/pure/today";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Dialog } from "../../../ui/dialog";
import { ReasonField } from "../../../ui/reason/reason-field";
import { reasonProblem, type Reason } from "../../../ui/reason/reason";
import { endToWire } from "../domain/grants";
import type { AccessGrant } from "../api";
import { linesText, scopeText, storedScope, untilText } from "../present";
import { EndPick } from "./end-pick";
import { refusalsOf, useGrantBatch } from "./use-grant-batch";
import { useAccessContext } from "./use-access-context";
import { useOrgRoots } from "./use-org-roots";
import { useReasons } from "./use-reasons";

const OTHER = "OTHER";

export type ChangeMode = "revoke" | "end";

/**
 * Revoke one grant, or change its last day: what it is, the choice (opened on the one the user pressed, `mode`), a reason,
 * then the passkey. The parent keys this by grant and mode, so each opening starts clean.
 */
export function GrantChange({ grant, mode: start, onClose, onDone }: { grant: AccessGrant | null; mode?: ChangeMode; onClose: () => void; onDone: (message: string) => void }) {
  const today = todayKst();
  const reasons = useReasons();
  const roots = useOrgRoots();
  const ctx = useAccessContext();
  const [mode, setMode] = useState<string | null>(start ?? null);
  const [end, setEnd] = useState<string | null>(null);
  const [reason, setReason] = useState<Reason>({ code: null, memo: "" });
  const [tried, setTried] = useState(false);
  const message = () => t(mode === "revoke" ? "access.change.revoked" : "access.change.ended", { name: grant?.account_display_name ?? "", role: grant?.role_name_ko ?? "" });
  const run = useGrantBatch({ onSuccess: () => (onDone(message()), reset()) });
  const reset = () => (setMode(null), setEnd(null), setReason({ code: null, memo: "" }), setTried(false));
  if (!grant) return null;
  const close = () => (reset(), onClose());
  const bad = !mode || (mode === "end" && (!end || end < today)) || reasonProblem(reason, OTHER) !== null;
  const send = () =>
    run.mutate({
      operations: [mode === "revoke" ? { op: "revoke", grant_id: grant.id } : { op: "set_end", grant_id: grant.id, valid_to: endToWire(end!) }],
      reason_code: reason.code!,
      reason_note: reason.memo.trim() || null,
    });
  const refusal = refusalsOf(run.error).get(0);
  return (
    <Dialog open title={t("access.change.title", { name: grant.account_display_name ?? "", role: grant.role_name_ko })} onClose={close}>
      <p className="muted">{t("access.change.what", { scope: storedScope(grant.scope, roots), until: untilText(grant.valid_to) })}</p>
      <ChoiceField
        label={t("access.change.mode")}
        required
        options={(["revoke", "end"] as const).map((k) => ({ value: k, label: t(`access.change.mode.${k}`), description: t(`access.change.mode.${k}.hint`) }))}
        value={mode}
        onChange={setMode}
        error={tried && !mode ? t("access.change.mode.missing") : undefined}
      />
      {mode === "end" && <EndPick value={end} onChange={setEnd} today={today} error={tried && !end ? t("access.grant.missing.end") : undefined} />}
      <ReasonField label={t("access.grant.reason")} codes={reasons.codes} other={OTHER} value={reason} onChange={setReason} memoMax={200} showErrors={tried} />
      {/* M7-grant-revoke: what is lost, in numbers, before the passkey. */}
      {mode === "revoke" && (
        <p>
          <strong>{t("accessGrants.loss", { name: grant.account_display_name ?? "", scope: scopeText(roots, grant.scope), what: linesText(ctx.roles.find((r) => r.id === grant.role_id)?.lines ?? []) || grant.role_name_ko })}</strong>
          <br />
          <span className="muted">{t("accessGrants.loss.foot")}</span>
        </p>
      )}
      <ActionBar
        notice={refusal ? <Banner tone="danger" live="assertive">{refusal}</Banner> : <PasskeyError error={run.error} />}
        actions={
          <>
            <Button variant="ghost" onClick={close}>{t("access.cancel")}</Button>
            <Button variant={mode === "revoke" ? "danger" : "primary"} disabled={run.isPending} onClick={() => (bad ? setTried(true) : send())}>
              {t(mode === "revoke" ? "access.change.commit.revoke" : "access.change.commit.end")}
            </Button>
          </>
        }
      />
    </Dialog>
  );
}
