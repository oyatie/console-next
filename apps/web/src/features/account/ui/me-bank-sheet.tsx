// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { createMyProfileChangeRequest } from "../api";
import { SelfChangeRequestSheet } from "./me-edit-sheet";

/**
 * Boolean-only payroll account registration attestation: strictly toggles boolean
 * registration state request without accepting, storing, or rendering raw account numbers.
 */
export function BankAccountAttestationButton({ currentRegistered }: { currentRegistered: boolean }) {
  const [open, setOpen] = useState(false);
  const [nextRegistered, setNextRegistered] = useState<boolean>(!currentRegistered);
  const [note, setNote] = useState("");

  const save = useCommand({
    run: (input: { registered: boolean; note: string | null }) =>
      createMyProfileChangeRequest({
        field: "bank_account_registered",
        bank_account_registered: input.registered,
        note: input.note,
      }),
    invalidates: ["/api/v1/me/profile", "/api/v1/change-requests"],
    onSuccess: () => setOpen(false),
    announce: () => t("account.selfEdit.bankSaved"),
  });

  const close = () => {
    if (save.isSending) return;
    setOpen(false);
    setNote("");
    save.reset();
  };

  return (
    <SelfChangeRequestSheet
      open={open}
      title={t("account.selfEdit.bankEditTitle")}
      isSending={save.isSending}
      isPending={save.isPending}
      error={save.error}
      onOpen={() => {
        save.reset();
        setNextRegistered(!currentRegistered);
        setNote("");
        setOpen(true);
      }}
      onClose={close}
      onSubmit={() => {
        if (save.isPending) return;
        save.mutate({ registered: nextRegistered, note: note.trim() || null });
      }}
    >
      <Field label={t("account.selfEdit.bankAttest")} required>
        {(props) => (
          <SelectInput
            {...props}
            value={nextRegistered ? "true" : "false"}
            onChange={(e) => setNextRegistered(e.target.value === "true")}
          >
            <option value="true">{t("account.selfEdit.bankAttestRegistered")}</option>
            <option value="false">{t("account.selfEdit.bankAttestUnregistered")}</option>
          </SelectInput>
        )}
      </Field>
      <Field label={t("account.selfEdit.addressNote")} required={false}>
        {(props) => (
          <TextInput
            {...props}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </Field>
    </SelfChangeRequestSheet>
  );
}
