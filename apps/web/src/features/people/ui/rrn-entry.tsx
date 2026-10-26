// SPDX-License-Identifier: LicenseRef-Proprietary
import { useRef, useState } from "react";
import { isMessageId, t } from "@console/i18n";
import { FORMATS, complete } from "../../../lib/pure/formats";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { Sheet } from "../../../ui/sheet/sheet";
import { recordRrn } from "../api/record";

// shortcut: gallery only while PUT /rrn is unserved; mount on both record surfaces when its generated contract ships.
export function RrnEntry({ employeeId, who }: { employeeId: string; who: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="ghost" onClick={() => setOpen(true)}>{t("empCard.rrn.record")}</Button>
    {open && <RrnEntrySheet key={employeeId} employeeId={employeeId} who={who} onClose={() => setOpen(false)} />}
  </>;
}

function RrnEntrySheet({ employeeId, who, onClose }: { employeeId: string; who: string; onClose: () => void }) {
  const input = useRef("");
  const [value, setValue] = useState("");
  const close = () => { input.current = ""; setValue(""); onClose(); };
  const command = useCommand({
    run: async () => {
      // The command captures the cleared ref, keeping digits out of mutation variables and callbacks.
      let secret = input.current;
      input.current = ""; setValue("");
      try { return await recordRrn(employeeId, secret); }
      finally { secret = ""; }
    },
    forget: true,
    invalidates: ["/api/v1/employees/{id}/rrn"],
    settle: true,
    onSuccess: () => {
      announce(t("empCard.rrn.recorded", { who }));
      onClose();
    },
  });
  return <Sheet open title={t("empCard.rrn.recordTitle")} subtitle={who} pending={command.isSending} locked={command.isChecking} onClose={close}
    consequence={t("empCard.rrn.recordConsequence", { who })}
    notice={<CommandError error={command.error} recover={false} own={code => {
      const key = `empCard.rrn.error.${code}`;
      return isMessageId(key) ? t(key) : undefined;
    }} />}
    actions={<>
      <Button onClick={close}>{t("uiSheet.close")}</Button>
      <Button variant="primary" disabled={command.isPending || !complete(FORMATS.rrn, value)} onClick={() => command.mutate(undefined)}>{t("empCard.rrn.record")}</Button>
    </>}>
    <MaskedField label={t("empCard.f.rrn")} required format={FORMATS.rrn} value={value} onChange={next => { input.current = next; setValue(next); command.reset(); }} />
  </Sheet>;
}
