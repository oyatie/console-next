// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { isMessageId, t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { PasskeyError } from "../../../lib/react/passkey-error";
import type { InviteWithRolesSlotProps } from "../../../reference/authz/ui/use-invite-roles-slot";
import { orgStructureRef } from "../../../reference/entity/api";
import { personName } from "../../../reference/person/present";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Composer } from "../../../ui/composer/composer";
import { ReasonField } from "../../../ui/reason/reason-field";
import { reasonProblem, type Reason } from "../../../ui/reason/reason";
import { catalogQuery, meQuery as myAccessQuery, rolesQuery } from "../api";
import {
  createAccessInvite,
  INVITE_WITH_ROLES_INVALIDATES,
  previewAccessInvite,
  type CreateAccessInviteBody,
  type PreviewAccessInviteResponse,
} from "../api/access-invite";
import { blankLine, endToWire, missing, ready, startProblem, startToWire, type DraftLine, type Start } from "../domain/grants";
import type { OrgNode } from "../domain/scope";
import { refusalText, scopeLabel } from "../present";
import { GrantLine } from "./grant-line";
import { StartPick } from "./grant-sheet-parts";
import { ScopeSheet } from "./scope-picker";
import { useReasons } from "./use-reasons";
import accessStyles from "./access.module.css";

const OTHER = "OTHER";

class InviteRefused extends Error {
  constructor(readonly preview: PreviewAccessInviteResponse) {
    super("invite_preview_refused");
  }
}

const ownInviteError = (code: string) => {
  const id = `accounts.code.${code}`;
  return isMessageId(id) ? t(id) : undefined;
};

export function InviteWithRolesSheet({
  accountFields,
  displayName,
  employeeId,
  normalizedLogin,
  accountBlockedWhy,
  onTriedAccount,
  onFocusInvalid,
  onClose,
  onIssued,
}: InviteWithRolesSlotProps) {
  const cat = useQuery(catalogQuery);
  const rolesQ = useQuery(rolesQuery);
  const meAccess = useQuery(myAccessQuery);
  const tree = useQuery(orgStructureRef);
  const reasons = useReasons();
  const today = todayKst();
  const [lines, setLines] = useState<DraftLine[]>(() => [blankLine(crypto.randomUUID())]);
  const [when, setWhen] = useState<string | null>(null);
  const [start, setStart] = useState<Start>({ when: null, date: "" });
  const [reason, setReason] = useState<Reason>({ code: null, memo: "" });
  const [tried, setTried] = useState(false);
  const [pickingKey, setPickingKey] = useState<string | null>(null);

  const roles = rolesQ.data?.items ?? [];
  const setup = meAccess.data?.phase !== "OPERATING";
  const roots = (tree.data?.entities ?? []) as OrgNode[];

  const atomicInvite = useCommand({
    run: async (body: CreateAccessInviteBody, key: string) => {
      const preview = await previewAccessInvite(body);
      if (preview.refused > 0) throw new InviteRefused(preview);
      return createAccessInvite(body, key);
    },
    invalidates: INVITE_WITH_ROLES_INVALIDATES,
    onSuccess: (out) => {
      onIssued({
        user_id: out.user.id,
        userId: out.user.id,
        name: personName(out.user.display_name),
        signInId: out.user.sign_in_id,
        otp: out.otp ?? "",
        expires_at: out.otp_expires_at,
        grantedCount: out.grants.length,
      });
    },
    forget: true,
  });

  const setLine = (next: DraftLine) => setLines(lines.map((x) => (x.key === next.key ? next : x)));
  const scoping = lines.find((l) => l.key === pickingKey);
  if (scoping && cat.data) {
    return (
      <ScopeSheet
        rules={cat.data.scope_kinds}
        value={scoping.scope}
        subtitle={[displayName || t("accounts.invite"), roles.find((r) => r.id === scoping.role_id)?.name_ko].filter(Boolean).join(" · ")}
        onDone={(scope) => (setLine({ ...scoping, scope }), setPickingKey(null))}
        onCancel={() => setPickingKey(null)}
      />
    );
  }

  const gaps = lines.map((l) => missing(l, lines, today));
  const refused =
    atomicInvite.error instanceof InviteRefused
      ? new Map(
          atomicInvite.error.preview.items
            .filter((i) => i.outcome === "REFUSED")
            .map((i) => [i.index, refusalText(i.refusal)]),
        )
      : new Map<number, string>();

  const grantProblems =
    gaps.some((g) => g.length > 0) ||
    (setup && !when) ||
    (!setup && startProblem(start, today)) ||
    reasonProblem(reason, OTHER) !== null;

  const fromDate = !setup && start.when === "DATE" ? start.date : null;
  const buildBody = (): CreateAccessInviteBody => ({
    display_name: displayName,
    employee_id: employeeId ?? null,
    sign_in_id: normalizedLogin,
    grants: lines.filter(ready).map((l) => ({
      role_id: l.role_id,
      scope: l.scope,
      ...(fromDate ? { valid_from: startToWire(fromDate) } : {}),
      valid_to: endToWire(l.end),
      effective_in_setup: setup && when === "SETUP",
    })),
    reason_code: reason.code,
    reason_note: reason.memo.trim() || null,
  });

  const submit = () => {
    setTried(true);
    onTriedAccount();
    if (accountBlockedWhy || grantProblems) {
      onFocusInvalid();
      return false;
    }
    atomicInvite.mutate(buildBody());
    return true;
  };

  const named = lines.filter(ready).map((l) =>
    t("access.grant.named", {
      role: roles.find((r) => r.id === l.role_id)?.name_ko ?? "",
      scope: scopeLabel(roots, l.scope),
      until: t("access.until", { date: l.end }),
    }),
  );

  const consequence =
    displayName === ""
      ? t("accounts.invite.consequence.pending")
      : named.length > 0
        ? t("accounts.invite.consequenceWithRoles", { name: displayName, count: named.length, grants: named.join(", ") })
        : t("access.grant.consequence.empty");

  const nonPreviewError = atomicInvite.error instanceof InviteRefused ? null : atomicInvite.error;

  return (
    <Composer
      open
      size="lg"
      title={t("accounts.invite")}
      action={{ kind: "accountInvite", mode: "assign", count: lines.length }}
      onClose={onClose}
      pending={atomicInvite.isPending}
      error={nonPreviewError}
      consequence={<span>{consequence}</span>}
      blocked={
        accountBlockedWhy
          ? { reason: accountBlockedWhy, press: () => { setTried(true); onTriedAccount(); onFocusInvalid(); } }
          : undefined
      }
      incomplete={grantProblems}
      notice={
        refused.size > 0 ? (
          <Banner tone="danger" live="assertive">{t("access.grant.refused", { count: refused.size })}</Banner>
        ) : nonPreviewError ? (
          <>
            <CommandError error={nonPreviewError} own={ownInviteError} />
            <PasskeyError error={nonPreviewError} />
          </>
        ) : undefined
      }
      onSubmit={submit}
    >
      {accountFields}
      {rolesQ.isSuccess && roles.length === 0 && <Banner>{t("access.grant.noRoles")}</Banner>}
      <div className={accessStyles.lines} role="group" aria-labelledby="invite-grant-lines">
        <strong id="invite-grant-lines">{t("access.grant.lines")}</strong>
        {lines.map((l, i) => (
          <GrantLine
            key={l.key}
            n={i + 1}
            line={l}
            roles={roles}
            today={today}
            missing={tried ? gaps[i]! : []}
            refusal={refused.get(i)}
            onChange={setLine}
            onPickScope={() => setPickingKey(l.key)}
            onRemove={lines.length > 1 ? () => setLines(lines.filter((x) => x.key !== l.key)) : undefined}
          />
        ))}
        <div>
          <Button variant="ghost" onClick={() => setLines([...lines, blankLine(crypto.randomUUID())])}>
            <Plus size={16} aria-hidden /> {t("access.grant.addLine")}
          </Button>
        </div>
      </div>
      {setup ? (
        <div className={accessStyles.when}>
          <ChoiceField
            label={t("access.grant.when")}
            required
            options={(["GO_LIVE", "SETUP"] as const).map((k) => ({
              value: k,
              label: t(`access.grant.when.${k}`),
              description: t(`access.grant.when.${k}.hint`),
            }))}
            value={when}
            onChange={setWhen}
            error={tried && !when ? t("access.grant.when.missing") : undefined}
          />
        </div>
      ) : (
        <StartPick value={start} onChange={setStart} today={today} tried={tried} />
      )}
      <ReasonField
        label={t("access.grant.reason")}
        codes={reasons.codes}
        other={OTHER}
        value={reason}
        onChange={setReason}
        memoMax={200}
        showErrors={tried}
      />
    </Composer>
  );
}
