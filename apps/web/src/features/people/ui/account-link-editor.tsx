// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { t } from "@console/i18n";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { ServerPicker } from "../../../ui/server-picker/server-picker";

/** The same link draft, pending confirmation and refusal on either side of an account–employee link. */
export function AccountLinkEditor({ picker, pending, busy, error, own, focusPicker, children }: {
  picker?: ComponentProps<typeof ServerPicker>;
  pending?: { title: string; approve?: () => void };
  busy: boolean;
  error?: unknown;
  own?: ComponentProps<typeof PasskeyError>["own"];
  focusPicker?: boolean;
  children?: ReactNode;
}) {
  const editor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusPicker || error) editor.current?.querySelector<HTMLInputElement>('[role="combobox"]')?.focus();
  }, [focusPicker, error]);
  return <div className="form" ref={editor}>
    {pending ? <Banner tone="info" live="polite" title={pending.title}
      actions={pending.approve && <Button variant="primary" disabled={busy} onClick={pending.approve}>
        {t("uiOverrideSheet.stepUp", { action: t("org.change.step.APPROVED") })}
      </Button>}
    /> : picker && <>
      <ServerPicker {...picker} />
      {children}
    </>}
    <PasskeyError error={error} own={own} />
  </div>;
}
