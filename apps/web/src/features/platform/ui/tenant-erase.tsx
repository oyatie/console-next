// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { isMessageId, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field, TextInput } from "../../../ui/field/field";
import { eraseWrite, operatorId, type EraseAction, type EraseRead, type Org } from "../api";

export type EraseRenderSlots = {
  banner: ReactNode;
  controls: ReactNode;
  reasons: ReactNode;
  dialog: ReactNode;
};

export function EraseControls({
  org,
  data,
  size = "md",
  children,
}: {
  org: Org;
  data: EraseRead;
  size?: "sm" | "md";
  children?: (slots: EraseRenderSlots) => ReactNode;
}) {
  const [opening, setOpening] = useState(false);
  const [typed, setTyped] = useState("");
  const request = data.request;
  const pending = request && !request.cancelled_at && !request.erased_at;
  const reason = !data.archived ? "tenant_active" : data.legal_hold ? "blocked_legal_hold" : !data.second_operator_available ? "erase_requires_second_operator" : undefined;
  const write = useCommand({
    run: (action: EraseAction, key: string) => eraseWrite(org, action === "open" ? key : request!.id, action),
    invalidates: ["/api/platform"],
    forget: true,
    onSuccess: () => { setOpening(false); setTyped(""); },
  });
  const refusal = (code: string) => {
    const id = `tenants.erase.${code}`;
    return isMessageId(id) ? t(id) : undefined;
  };
  const close = () => { setOpening(false); setTyped(""); write.reset(); };
  const approveReason = reason ?? (request?.requested_by === operatorId() ? "erase_same_operator" : undefined);
  const banner = <PasskeyError error={write.error} own={refusal} />;
  const dialog = (
    <Dialog open={opening} title={t("tenants.erase.open")} onClose={close} dismissable={!typed && !write.isPending}>
      <p>{t("tenants.erase.consequence", { org: org.name, hours: data.cooling_hours })}</p>
      <Field label={t("tenants.remove.force.typeSlug", { slug: org.slug })} required>
        {(p) => <TextInput {...p} autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />}
      </Field>
      <PasskeyError error={write.error} own={refusal} />
      <div className="form__actions">
        <Button onClick={close}>{t("common.cancel")}</Button>
        <Button variant="danger" disabled={Boolean(reason) || typed !== org.slug || write.isPending} onClick={() => write.mutate("open")}>{t("tenants.erase.open")}</Button>
      </div>
    </Dialog>
  );

  if (children) {
    if (pending) {
      const cancelBtn = <Button size={size} disabled={write.isPending} onClick={() => write.mutate("cancel")}>{t("tenants.erase.cancel")}</Button>;
      if (request.cooling_until) {
        return (
          <DisabledReason
            control={(p) => <Button size={size} {...p}>{t("tenants.erase.scheduled")}</Button>}
            reason={t("tenants.erase.coolingUntil", { at: fmtDateTime(request.cooling_until) })}
          >
            {({ control, reason: why }) => children({ banner, controls: <>{control}{cancelBtn}</>, reasons: why, dialog })}
          </DisabledReason>
        );
      }
      if (approveReason) {
        return (
          <DisabledReason
            control={(p) => <Button size={size} {...p}>{t("tenants.erase.approve")}</Button>}
            reason={refusal(approveReason)}
          >
            {({ control, reason: why }) => children({ banner, controls: <>{control}{cancelBtn}</>, reasons: why, dialog })}
          </DisabledReason>
        );
      }
      return children({
        banner,
        controls: (
          <>
            <Button size={size} disabled={write.isPending} onClick={() => write.mutate("approve")}>{t("tenants.erase.approve")}</Button>
            {cancelBtn}
          </>
        ),
        reasons: null,
        dialog,
      });
    }
    if (reason) {
      return (
        <DisabledReason
          control={(p) => <Button size={size} {...p}>{t("tenants.remove.force", { org: org.name })}</Button>}
          reason={refusal(reason)}
        >
          {({ control, reason: why }) => children({ banner, controls: control, reasons: why, dialog })}
        </DisabledReason>
      );
    }
    return children({
      banner,
      controls: <Button size={size} onClick={() => setOpening(true)}>{t("tenants.remove.force", { org: org.name })}</Button>,
      reasons: null,
      dialog,
    });
  }

  return <>
    {banner}
    {pending ? <>
      {request.cooling_until ? <DisabledReason control={p => <Button size={size} {...p}>{t("tenants.erase.scheduled")}</Button>}
        reason={t("tenants.erase.coolingUntil", { at: fmtDateTime(request.cooling_until) })} /> : <>
        {approveReason ? <DisabledReason control={p => <Button size={size} {...p}>{t("tenants.erase.approve")}</Button>} reason={refusal(approveReason)} />
          : <Button size={size} disabled={write.isPending} onClick={() => write.mutate("approve")}>{t("tenants.erase.approve")}</Button>}
      </>}
      <Button size={size} disabled={write.isPending} onClick={() => write.mutate("cancel")}>{t("tenants.erase.cancel")}</Button>
    </> : reason ? <DisabledReason control={p => <Button size={size} {...p}>{t("tenants.remove.force", { org: org.name })}</Button>} reason={refusal(reason)} />
      : <Button size={size} onClick={() => setOpening(true)}>{t("tenants.remove.force", { org: org.name })}</Button>}
    {dialog}
  </>;
}
