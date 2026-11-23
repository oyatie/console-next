// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button, Form } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { Field, TextInput } from "../../../ui/field/field";
import { selfEditError, updatePhone } from "../api";
import s from "./account.module.css";

const MASKED_PHONE_RE = /[•●*]/;

/** Self-service phone edit/clear modal sheet (`PATCH /api/v1/me/profile`). */
export function PhoneEditButton({ currentMasked }: { currentMasked: string | null }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const hasMasked = MASKED_PHONE_RE.test(phone);
  const save = useCommand({
    run: (next: string | null) => updatePhone(next, currentMasked),
    invalidates: ["/api/v1/me/profile", "/api/v1/users/me"],
    onSuccess: () => setOpen(false),
    announce: () => t("account.selfEdit.phoneSaved"),
  });

  const close = () => {
    if (save.isSending) return;
    setOpen(false);
    setPhone("");
    save.reset();
  };

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        className={s.actionBtn}
        onClick={() => {
          save.reset();
          setPhone("");
          setOpen(true);
        }}
      >
        {t("account.selfEdit.phoneEdit")}
      </Button>
      <Dialog open={open} title={t("account.selfEdit.phoneEditTitle")} onClose={close}>
        <Form
          aria-busy={save.isSending}
          onSubmit={() => {
            if (save.isPending) return;
            const trimmed = phone.trim();
            if (!trimmed || MASKED_PHONE_RE.test(trimmed)) return;
            save.mutate(trimmed);
          }}
        >
          <Field
            label={t("account.selfEdit.phone")}
            required={false}
            error={hasMasked ? t("account.selfEdit.emergencyPhoneInvalid") : undefined}
          >
            {(props) => (
              <TextInput
                {...props}
                type="tel"
                value={phone}
                placeholder={t("account.selfEdit.phoneFormatHint")}
                onChange={(e) => setPhone(e.target.value)}
              />
            )}
          </Field>
          <CommandError error={save.error} own={selfEditError} />
          <div className="form__actions">
            {currentMasked && (
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => save.mutate(null)}
              >
                {t("account.selfEdit.clearPhone")}
              </Button>
            )}
            <Button type="button" disabled={save.isSending} onClick={close}>
              {t("composer.dismiss")}
            </Button>
            <Button type="submit" variant="primary" disabled={save.isPending || !phone.trim()}>
              {t("account.selfEdit.phoneEdit")}
            </Button>
          </div>
        </Form>
      </Dialog>
    </>
  );
}
