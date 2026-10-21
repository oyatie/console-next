import { t } from "@console/i18n";
import { FORMATS, validEmail } from "../../../lib/pure/formats";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import type { Addr } from "../domain/record-values";
import { AddressEdit } from "./record-address-edit";
import { INFO_LABEL } from "../present";

/** A workplace's own facts as its edit sheet holds them (company-11): every one the record shows, each its own row. */
export type InfoDraft = { name: string; representative: string; product: string; phone: string; fax: string; email: string; mail: Addr | null; openedOn: string };
export type InfoKey = keyof InfoDraft;

/**
 * The one fact a row's edit opens (record-actions §3, §13.18: each edit changes exactly the value its row shows): name,
 * representative, main product, phone, fax, e-mail, mailing address, or the opening date (a correction only: it is when the
 * place opened, not a change).
 */
export function InfoField({ only, d, set, today, openedFrom }: { only: InfoKey; d: InfoDraft; set: <K extends InfoKey>(k: K, v: InfoDraft[K]) => void; today: string; openedFrom: string }) {
  const label = INFO_LABEL[only]();
  switch (only) {
    case "name":
    case "representative":
    case "product":
      return (
        <Field label={label} required={only === "name"}>
          {(c) => <TextInput {...c} maxLength={only === "representative" ? 100 : 200} value={d[only]} onChange={(x) => set(only, x.target.value)} />}
        </Field>
      );
    case "phone":
    case "fax":
      return <MaskedField label={label} required={false} format={FORMATS.phone} value={d[only]} onChange={(v) => set(only, v)} />;
    case "email":
      return (
        <Field label={label} required={false} error={d.email && !validEmail(d.email) ? t("workplace.problem.emailInvalid") : undefined}>
          {(c) => <TextInput {...c} type="email" value={d.email} onChange={(x) => set("email", x.target.value)} />}
        </Field>
      );
    case "mail":
      return <AddressEdit label={label} required={false} v={d.mail} set={(v) => set("mail", v)} />;
    case "openedOn":
      return <DateField label={label} required value={d.openedOn} onChange={(v) => set("openedOn", v)} today={today} max={today} basis={t("entityOps.info.openedHint", { date: openedFrom })} />;
  }
}
