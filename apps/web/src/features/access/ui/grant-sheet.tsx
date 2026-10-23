import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, Plus } from "lucide-react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { todayKst } from "../../../lib/pure/today";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { ReasonField } from "../../../ui/reason/reason-field";
import { reasonProblem, type Reason } from "../../../ui/reason/reason";
import { Sheet } from "../../../ui/sheet/sheet";
import { orgStructureRef } from "../../../reference/entity/api";
import { blankLine, grantOp, missing, ready, startProblem, type DraftLine, type Start } from "../domain/grants";
import type { OrgNode } from "../domain/scope";
import { ACCESS_READS, applyGrants, previewGrants, type AccessGrantPreview, type Batch, type AccessCatalog, type AccessGrant, type AccessRole, type Account } from "../api";
import { enforcementText, grantDoneText, scheduledText, scopeLabel } from "../present";
import { PersonHead } from "./holder";
import { GrantLine } from "./grant-line";
import { CurrentGrants, GrantPreviewSummary, StartPick } from "./grant-sheet-parts";
import { ScopeSheet } from "./scope-picker";
import { Refused, refusalsOf } from "./use-grant-batch";
import { useReasons } from "./use-reasons";
import s from "./access.module.css";

const OTHER = "OTHER";

/**
 * grant for one account (mockup M4): several roles, each with its own scope and end, under one reason. The server
 * previews every line, then one passkey applies them all or none. While SETUP lasts the grants wait for go-live unless
 * "from setup" is chosen. Nobody grants to themselves and the ops account already holds everything: both are refused
 * here before any request. Picking a line's scope turns this sheet into the scope view and back (mockup M3).
 */
export function GrantSheet({ account, me, ops, cat, roles, setup, onClose, onGranted }: {
  account: Account | null;
  me: string | undefined;
  ops: string | undefined;
  cat: AccessCatalog;
  roles: readonly AccessRole[];
  setup: boolean;
  onClose: () => void;
  /** The saved grants come back with the message, for the receipt's undo. */
  onGranted: (message: string, made: AccessGrant[], operationId: string) => void;
}) {
  const tree = useQuery(orgStructureRef);
  const reasons = useReasons();
  const today = todayKst();
  const [lines, setLines] = useState<DraftLine[]>([blankLine(crypto.randomUUID())]);
  const [when, setWhen] = useState<string | null>(null);
  const [start, setStart] = useState<Start>({ when: null, date: "" });
  const [reason, setReason] = useState<Reason>({ code: null, memo: "" });
  const [tried, setTried] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [preview, setPreview] = useState<AccessGrantPreview | null>(null);
  const run = useCommand({
    run: (receipt: string, key: string) => applyGrants(receipt, key),
    invalidates: ACCESS_READS,
    onSuccess: (out) => onGranted(grantDoneText(account?.display_name ?? "", out.items), out.items, out.operation_id),
  });
  const check = useCommand({
    run: async (batch: Batch) => {
      const p = await previewGrants(batch);
      if (p.refused) throw new Refused(p);
      return p;
    },
    onSuccess: (p) => p.items.some((i) => scheduledText(i)) ? setPreview(p) : run.mutate(p.receipt_id),
    announce: (p) => p.items.map(scheduledText).filter(Boolean).join(" · "),
  });
  const pending = check.isPending || run.isPending;
  const error = run.error ?? check.error;
  if (!account) return null;
  const roots = (tree.data?.entities ?? []) as OrgNode[];
  const set = (next: DraftLine) => setLines(lines.map((x) => (x.key === next.key ? next : x)));
  const scoping = lines.find((l) => l.key === picking);
  if (scoping)
    return (
      <ScopeSheet
        rules={cat.scope_kinds}
        value={scoping.scope}
        subtitle={[account.display_name, roles.find((r) => r.id === scoping.role_id)?.name_ko].filter(Boolean).join(" · ")}
        onDone={(scope) => (set({ ...scoping, scope }), setPicking(null))}
        onCancel={() => setPicking(null)}
      />
    );
  const gaps = lines.map((l) => missing(l, lines, today));
  const refused = refusalsOf(error);
  const blocked = account.id === me ? "self" : account.id === ops ? "ops" : null;
  const problems = gaps.some((g) => g.length) || (setup && !when) || (!setup && startProblem(start, today)) || reasonProblem(reason, OTHER) !== null;
  const from = !setup && start.when === "DATE" ? start.date : null;
  const send = () =>
    check.mutate({ operations: lines.filter(ready).map((l) => grantOp(account.id, l, setup && when === "SETUP", from)), reason_code: reason.code!, reason_note: reason.memo.trim() || null });
  const close = () => (setLines([blankLine(crypto.randomUUID())]), setTried(false), setWhen(null), setStart({ when: null, date: "" }), setReason({ code: null, memo: "" }), onClose());
  const named = lines.filter(ready).map((l) => t("access.grant.named", { role: roles.find((r) => r.id === l.role_id)?.name_ko ?? "", scope: scopeLabel(roots, l.scope), until: t("access.until", { date: l.end }) }));
  const live = !setup || when === "SETUP";
  // ROL-M4-grant-person: a narrower-than-tenant HR line says what it reaches (AX-5) before it is saved.
  const HR = new Set(["hr_basic", "appointment", "exit"]);
  const scopedHr = lines.some((l) => ready(l) && l.scope.kind !== "TENANT" && roles.find((r) => r.id === l.role_id)?.lines.some((x) => HR.has(x.domain)));
  const consequence = blocked ? (
    <>
      <strong className={s.bad}>{t(`access.grant.blocked.${blocked}`)}</strong>
      <span className="muted">{t("access.grant.blocked.foot")}</span>
    </>
  ) : named.length ? (
    <>
      {preview ? preview.items.map((item) => <strong key={item.index}>{named[item.index]} · {scheduledText(item) ?? enforcementText(item.enforcement_after ?? "")}</strong>) : (
        <strong>{from ? t("accessGrants.consequence.from", { name: account.display_name, grants: named.join(", "), date: from }) : t(live ? "access.grant.consequence.now" : "access.grant.consequence.golive", { name: account.display_name, grants: named.join(", ") })}</strong>
      )}
      {scopedHr && <span className="muted">{t("accessGrants.scoped.note")}</span>}
      <span className="muted">{t(account.has_passkey ? "access.grant.consequence.kept" : "access.grant.consequence.noPasskey", { name: account.display_name })}</span>
    </>
  ) : (
    <span className="muted">{t("access.grant.consequence.empty")}</span>
  );
  const commit = <><Lock size={16} aria-hidden />{t("access.grant.commit", { count: lines.length })}</>;
  return (
    <Sheet
      open
      wide
      title={t("access.grant.title")}
      subtitle={<PersonHead a={account} ops={account.id === ops} />}
      onClose={close}
      pending={pending}
      consequence={consequence}
      notice={refused.size ? <Banner tone="danger" live="assertive">{t("access.grant.refused", { count: refused.size })}</Banner> : <PasskeyError error={error} />}
      actions={
        <>
          <Button variant="ghost" onClick={preview ? () => (run.reset(), setPreview(null)) : close}>{t(preview ? "access.bulk.back" : "access.cancel")}</Button>
          {blocked ? (
            <DisabledReason reason={t(`access.grant.blocked.${blocked}`)} control={(p) => <Button variant="primary" {...p}>{commit}</Button>} />
          ) : (
            <Button variant="primary" disabled={pending} onClick={() => (preview ? run.mutate(preview.receipt_id) : problems ? setTried(true) : send())}>{commit}</Button>
          )}
        </>
      }
    >
      {preview ? <GrantPreviewSummary items={preview.items} named={named} /> : <>
        {blocked && <Banner tone="danger">{t(`access.grant.blocked.${blocked}`)} · {t(`access.grant.blocked.${blocked}.why`)}</Banner>}
        {!roles.length && <Banner>{t("access.grant.noRoles")}</Banner>}
        <CurrentGrants accountId={account.id} />
        <div className={s.lines} role="group" aria-labelledby="ac-lines">
          <span id="ac-lines" className="field__label">{t("access.grant.lines")}</span>
          {lines.map((l, i) => (
            <GrantLine
              key={l.key}
              n={i + 1}
              line={l}
              roles={roles}
              today={today}
              missing={tried ? gaps[i]! : []}
              refusal={refused.get(i)}
              onChange={set}
              onPickScope={() => setPicking(l.key)}
              onRemove={lines.length > 1 ? () => setLines(lines.filter((x) => x.key !== l.key)) : undefined}
            />
          ))}
          <div><Button variant="ghost" onClick={() => setLines([...lines, blankLine(crypto.randomUUID())])}><Plus size={16} aria-hidden />{t("access.grant.addLine")}</Button></div>
        </div>
        {setup && (
          <div className={s.when}>
            <ChoiceField
              label={t("access.grant.when")}
              required
              options={(["GO_LIVE", "SETUP"] as const).map((k) => ({ value: k, label: t(`access.grant.when.${k}`), description: t(`access.grant.when.${k}.hint`) }))}
              value={when}
              onChange={setWhen}
              error={tried && !when ? t("access.grant.when.missing") : undefined}
            />
          </div>
        )}
        {!setup && <StartPick value={start} onChange={setStart} today={today} tried={tried} />}
        <ReasonField label={t("access.grant.reason")} codes={reasons.codes} other={OTHER} value={reason} onChange={setReason} memoMax={200} showErrors={tried} />
      </>}
    </Sheet>
  );
}
