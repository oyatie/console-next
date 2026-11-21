// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { t } from "@console/i18n";
import { phoneDisplay, phoneE164, toDomestic } from "../../../lib/pure/formats";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { Button, Check, Form } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import {
  revealMyProfileField,
  selfEditError,
  updateEmergencyContacts,
  type SelfEmergencyContactInput,
  type SelfEmergencyContactSummary,
} from "../api";
import { parseRevealedEmergencyContacts } from "../domain/profile";
import s from "./account.module.css";

const RELATIONS = ["SPOUSE", "PARENT", "CHILD", "SIBLING", "RELATIVE", "OTHER"] as const;
const MAX_CONTACTS = 3;

type Relation = (typeof RELATIONS)[number];
type ContactDraft = {
  id: number;
  name: string;
  relation: Relation;
  phone: string;
};

let nextDraftId = 1;
const blankContact = (): ContactDraft => ({ id: nextDraftId++, name: "", relation: "SPOUSE", phone: "" });

export function EmergencyContactsButton({
  employeeId,
  existing,
}: {
  employeeId: string;
  existing: readonly SelfEmergencyContactSummary[];
}) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<ContactDraft[]>(() => [blankContact()]);
  const [notified, setNotified] = useState(false);
  const [tried, setTried] = useState(false);

  const prefill = useCommand({
    run: () => revealMyProfileField(employeeId, "EMERGENCY_CONTACTS"),
    forget: true,
    onSuccess: (res) => {
      const revealed = parseRevealedEmergencyContacts(res.value);
      if (revealed.length > 0) {
        setDrafts(
          revealed.slice(0, MAX_CONTACTS).map((c) => ({
            id: nextDraftId++,
            name: c.name,
            relation: (RELATIONS.includes(c.relation as Relation) ? c.relation : "OTHER") as Relation,
            phone: phoneDisplay(c.phone) || toDomestic(c.phone),
          })),
        );
      }
    },
  });

  const save = useCommand({
    run: (contacts: SelfEmergencyContactInput[]) => updateEmergencyContacts(contacts),
    invalidates: ["/api/v1/me/profile"],
    onSuccess: () => {
      setOpen(false);
      setDrafts([blankContact()]);
      setNotified(false);
      setTried(false);
    },
    announce: () => t("account.selfEdit.emergencySaved"),
  });

  const close = () => {
    if (save.isSending || prefill.isSending) return;
    setOpen(false);
    setDrafts([blankContact()]);
    setNotified(false);
    setTried(false);
    save.reset();
    prefill.reset();
  };

  const openModal = () => {
    save.reset();
    prefill.reset();
    setTried(false);
    setNotified(false);
    setDrafts(
      existing.length > 0
        ? existing.slice(0, MAX_CONTACTS).map((c) => ({
            id: nextDraftId++,
            name: c.name,
            relation: c.relation,
            phone: "",
          }))
        : [blankContact()],
    );
    setOpen(true);
  };

  const validateAll = () => {
    if (drafts.length === 0) return { ok: true as const, payload: [] as SelfEmergencyContactInput[] };
    if (!notified) return { ok: false as const };
    const payload: SelfEmergencyContactInput[] = [];
    for (const c of drafts) {
      const name = c.name.trim();
      const e164 = phoneE164(c.phone);
      if (!name || !e164) return { ok: false as const };
      payload.push({ name, relation: c.relation, phone: e164, contact_notified: true });
    }
    return { ok: true as const, payload };
  };

  return (
    <>
      <Button size="sm" variant="secondary" className={s.actionBtn} onClick={openModal}>
        {t("account.selfEdit.phoneEdit")}
      </Button>
      <Dialog open={open} title={t("account.selfEdit.emergencyEditTitle")} onClose={close}>
        <Form
          className={s.form}
          aria-busy={save.isSending}
          onSubmit={() => {
            if (save.isPending) return;
            setTried(true);
            const result = validateAll();
            if (!result.ok) return;
            save.mutate(result.payload);
          }}
        >
          {existing.length > 0 && (
            <div className={s.fieldChips}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={prefill.isPending || save.isPending}
                onClick={() => {
                  prefill.reset();
                  prefill.mutate(undefined);
                }}
              >
                {t("account.selfEdit.emergencyRevealPrefill")}
              </Button>
              <PasskeyError error={prefill.error} own={selfEditError} />
            </div>
          )}
          {drafts.map((item, idx) => {
            const nameMissing = tried && !item.name.trim();
            const phoneBad = tried && !phoneE164(item.phone);
            return (
              <div key={item.id} className={s.contactGroup}>
                <div className={s.contactRowHead}>
                  <strong className="t-sm">
                    {t("account.selfEdit.emergency")} {idx + 1}
                  </strong>
                  {drafts.length > 1 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={save.isPending}
                      onClick={() => setDrafts((prev) => prev.filter((x) => x.id !== item.id))}
                    >
                      <Trash2 size={14} aria-hidden="true" /> {t("account.selfEdit.emergencyRemove")}
                    </Button>
                  )}
                </div>
                <Field
                  label={t("account.selfEdit.emergencyName")}
                  required
                  error={nameMissing ? t("account.selfEdit.emergencyNameRequired") : undefined}
                >
                  {(props) => (
                    <TextInput
                      {...props}
                      maxLength={100}
                      value={item.name}
                      onChange={(e) =>
                        setDrafts((prev) =>
                          prev.map((x) => (x.id === item.id ? { ...x, name: e.target.value } : x)),
                        )
                      }
                    />
                  )}
                </Field>
                <Field label={t("account.selfEdit.emergencyRelation")} required>
                  {(props) => (
                    <SelectInput
                      {...props}
                      value={item.relation}
                      onChange={(e) =>
                        setDrafts((prev) =>
                          prev.map((x) => (x.id === item.id ? { ...x, relation: e.target.value as Relation } : x)),
                        )
                      }
                    >
                      {RELATIONS.map((rel) => (
                        <option key={rel} value={rel}>
                          {t(`empCard.relation.${rel}`)}
                        </option>
                      ))}
                    </SelectInput>
                  )}
                </Field>
                <Field
                  label={t("account.selfEdit.emergencyPhone")}
                  required
                  error={phoneBad ? t("account.selfEdit.emergencyPhoneInvalid") : undefined}
                >
                  {(props) => (
                    <TextInput
                      {...props}
                      type="tel"
                      inputMode="numeric"
                      value={item.phone}
                      placeholder={t("account.selfEdit.phoneFormatHint")}
                      onChange={(e) =>
                        setDrafts((prev) =>
                          prev.map((x) => (x.id === item.id ? { ...x, phone: e.target.value } : x)),
                        )
                      }
                      onBlur={() =>
                        setDrafts((prev) =>
                          prev.map((x) =>
                            x.id === item.id
                              ? { ...x, phone: phoneDisplay(x.phone) || x.phone }
                              : x,
                          ),
                        )
                      }
                    />
                  )}
                </Field>
              </div>
            );
          })}
          {drafts.length < MAX_CONTACTS && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={save.isPending}
              onClick={() => setDrafts((prev) => [...prev, blankContact()])}
            >
              <Plus size={14} aria-hidden="true" /> {t("account.selfEdit.emergencyAdd")}
            </Button>
          )}
          <Check checked={notified} onChange={setNotified}>
            {t("account.selfEdit.emergencyNotified")}
          </Check>
          {tried && !notified && (
            <div role="alert" className="t-sm t-danger">
              {t("account.selfEdit.emergencyNotifiedRequired")}
            </div>
          )}
          <CommandError error={save.error} own={selfEditError} />
          <div className="form__actions">
            {existing.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => save.mutate([])}
              >
                {t("account.selfEdit.emergencyClear")}
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
