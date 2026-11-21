// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button, Form } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { Dialog } from "../../../ui/dialog";
import { Field, TextInput } from "../../../ui/field/field";
import { updatePhone, type ChangeRequest, type Me } from "../api";
import s from "./account.module.css";

function correctionEntries(payload: Record<string, unknown> | undefined) {
  const changes = payload?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  return Object.entries(changes as Record<string, unknown>);
}

function correctionFieldLabel(key: string): string {
  switch (key) {
    case "address":
      return t("empCard.f.address");
    case "phone":
      return t("empCard.f.phone");
    case "emergency_contacts":
    case "emergency_contact":
      return t("empCard.f.emergency");
    case "bank_account":
    case "bank_account_registered":
      return t("account.accessLog.field.BANK_ACCOUNT");
    default:
      return t("account.selfEdit.correctionLabel");
  }
}

function PhoneEditButton({ current }: { current: string | null }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(current ?? "");
  const save = useCommand({
    run: (next: string | null) => updatePhone(next, current),
    invalidates: ["/api/v1/users/me"],
    onSuccess: () => setOpen(false),
    announce: () => t("account.selfEdit.phoneSaved"),
  });

  const close = () => {
    if (save.isSending) return;
    setOpen(false);
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
          setPhone(current ?? "");
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
            if (trimmed === (current ?? "").trim()) {
              setOpen(false);
              return;
            }
            save.mutate(trimmed || null);
          }}
        >
          <Field label={t("account.selfEdit.phone")} required={false}>
            {props => (
              <TextInput
                {...props}
                type="tel"
                value={phone}
                placeholder={t("account.selfEdit.phoneFormatHint")}
                onChange={e => setPhone(e.target.value)}
              />
            )}
          </Field>
          <CommandError error={save.error} />
          <div className="form__actions">
            {current && (
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
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {t("account.selfEdit.phoneEdit")}
            </Button>
          </div>
        </Form>
      </Dialog>
    </>
  );
}

export function SelfEditableBody({
  me,
  changeRequests,
}: {
  me: Me;
  changeRequests?: readonly ChangeRequest[];
}) {
  const openCorrections = (changeRequests ?? []).filter(
    item => item.kind === "PROFILE_CORRECTION" && item.status === "OPEN",
  );

  return (
    <ul className="list-divided list-divided--rows" aria-label={t("account.selfEdit.title")}>
      <li className={s.editRow}>
        <div className={s.editRowBody}>
          <div className={s.fieldChips}>
            <strong className="t-strong">{t("account.selfEdit.phone")}</strong>
            <Chip tone="outline" className={s.actionBtn}>
              {t("account.selfEdit.policy.instant")}
            </Chip>
          </div>
          <div className={me.phone ? "num" : "muted"}>
            {me.phone ?? t("person.field.notSet")}
          </div>
        </div>
        <div className={s.editRowActions}>
          <PhoneEditButton current={me.phone} />
        </div>
      </li>
      {openCorrections.map(req => {
        const entries = correctionEntries(req.payload);
        const primary = entries[0];
        const fieldLabel = primary ? correctionFieldLabel(primary[0]) : t("account.selfEdit.correctionLabel");
        const valueText =
          primary && typeof primary[1] === "string" && primary[1].trim()
            ? primary[1].trim()
            : null;
        return (
          <li key={req.id} className={s.editRow}>
            <div className={s.editRowBody}>
              <div className={s.fieldChips}>
                <strong className="t-strong">{fieldLabel}</strong>
                <Chip tone="outline" className={s.actionBtn}>
                  {t("account.selfEdit.policy.approval")}
                </Chip>
              </div>
              <div className={s.fieldChips}>
                {valueText && <div>{valueText}</div>}
                <Chip tone="warn" className={s.actionBtn}>
                  {t("account.selfEdit.correctionPending")}
                </Chip>
              </div>
            </div>
            <div className={s.editRowActions}>
              <Link
                to="/people/requests"
                search={{ lane: "me", status: "OPEN", sel: req.id }}
                className={buttonClass("secondary", { size: "sm", className: s.actionBtn })}
              >
                {t("account.selfEdit.viewProgress")}
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
