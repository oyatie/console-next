// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button, Form } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { Field, TextInput } from "../../../ui/field/field";
import { updateName } from "../api";

/** Display names are user-chosen in both realms; the server validates and audits the same self-profile command. */
export function ProfileName({ current }: { current: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(current);
  const save = useCommand({ run: updateName, invalidates: ["/api/v1/users/me", "/api/platform/users/me"],
    onSuccess: () => setOpen(false), announce: () => t("account.name.saved") });
  return <>
    <Button variant="ghost" onClick={() => { setName(current); setOpen(true); }}>{t("account.name.edit")}</Button>
    <Dialog open={open} title={t("account.name.edit")} onClose={() => setOpen(false)}>
      <Form onSubmit={() => save.mutate(name.trim())}>
        <Field label={t("account.field.name")} required>{(props) => <TextInput {...props} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <CommandError error={save.error} />
        <div className="form__actions"><Button type="submit" disabled={!name.trim() || save.isPending}>{t("account.name.edit")}</Button></div>
      </Form>
    </Dialog>
  </>;
}
