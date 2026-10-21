import { useState } from "react";
import { t } from "@console/i18n";
import { validEmail } from "../../../lib/pure/formats";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button, Form } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Dialog } from "../../../ui/dialog";
import { Field, TextInput } from "../../../ui/field/field";
import { recordContact, SETUP_READS } from "../api";

type Role = "REPRESENTATIVE" | "CPO" | "SELF";

/**
 * The out-of-band security contact (decision #7, design §5.4): who is told about elevated grants and
 * sole-holder decisions. Recorded is enough to start operations. No mail is sent (decisions #16), so there is
 * no emailed code to verify it with.
 */
export function SecurityContact({ onClose }: { onClose: () => void }) {
  const [role, setRole] = useState<Role | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const record = useCommand({ run: () => recordContact({ role: role!, name: name.trim(), email: email.trim() }), invalidates: SETUP_READS, announce: () => t("setup.contact.recorded"), onSuccess: onClose });
  const ready = role !== null && name.trim() !== "" && validEmail(email);
  return (
    <Dialog open title={t("setup.contact.title")} onClose={onClose}>
      <Form className="form" onSubmit={() => ready && record.mutate(undefined)}>
        <ChoiceField
          label={t("setup.contact.role")}
          required
          options={(["REPRESENTATIVE", "CPO", "SELF"] as const).map((r) => ({ value: r, label: t(`setup.contact.role.${r}`), description: t(`setup.contact.roleHint.${r}`) }))}
          value={role}
          onChange={(v) => setRole(v as Role)}
        />
        <div className="grid-3">
          <Field label={t("setup.contact.name")} required>{(c) => <TextInput {...c} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label={t("setup.contact.email")} required error={email && !validEmail(email) ? t("setup.contact.emailInvalid") : undefined}>
            {(c) => <TextInput {...c} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
        </div>
        <CommandError error={record.error} />
        <div className="form__actions">
          <Button onClick={onClose}>{t("common.back")}</Button>
          {ready ? <Button type="submit" variant="primary" disabled={record.isPending}>{t("setup.contact.save")}</Button> : <DisabledReason layout="inline" reason={t("setup.contact.notReady")} control={(p) => <Button variant="primary" {...p}>{t("setup.contact.save")}</Button>} />}
        </div>
      </Form>
    </Dialog>
  );
}
