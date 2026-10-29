import { useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { isMessageId, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { actor } from "../../../lib/labels";
import { FORMATS, phoneE164, toDomestic } from "../../../lib/pure/formats";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Check } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { FieldRow } from "../../../ui/record/field-row";
import { ListAdd, PathNote, RowActions } from "../../../ui/record-actions/record-actions";
import { Composer } from "../../../ui/composer/composer";
import { correctEmployee } from "../api";
import { maskedPhone } from "../domain/card";
import type { Card } from "./use-card";
import type { Quick } from "./use-quick";
import { Who } from "./card-who";
import s from "./card.module.css";
import { Muted } from "../../../ui/muted/muted";

type Contact = components["schemas"]["EmergencyContact"];
const RELATIONS: Contact["relation"][] = ["SPOUSE", "PARENT", "CHILD", "SIBLING", "RELATIVE", "OTHER"];
const route = getRouteApi("/app/people/$id");

/** The server keeps at most three (MR-34). */
const MAX = 3;
const QUICK = "QUICK_EDIT";
const EMERGENCY_CONTACT_REFUSAL_CODE = "emergency_contact_notice_unconfirmed";

const basisLabel = (basis: string) => {
  const key = `empContact.basis.${basis}`;
  return t(isMessageId(key) ? key : "empContact.basis.unknown");
};

const toInput = ({ name, relation, phone, contact_notified }: Contact): Contact => ({ name, relation, phone, contact_notified: contact_notified ?? false });

function buildEmergencyContactWrite(
  list: readonly Contact[],
  at: number | null,
  draft: { name: string; relation: Contact["relation"] | ""; phone: string; notified: boolean },
): { ok: true; contacts: Contact[] } | { ok: false; code: string } {
  if (!draft.notified) return { ok: false, code: EMERGENCY_CONTACT_REFUSAL_CODE };
  const trimmed = draft.name.trim();
  const e164 = draft.phone ? phoneE164(draft.phone) : null;
  if (!trimmed || !draft.relation || !e164) return { ok: false, code: "validation_failed" };
  const entry: Contact = { name: trimmed, relation: draft.relation, phone: e164, contact_notified: true };
  const clean = list.map(toInput);
  const contacts = at === null ? [...clean, entry] : clean.map((x, i) => (i === at ? entry : x));
  return { ok: true, contacts };
}

/**
 * Emergency contacts (MR-34) as their own list on the card: the list's add in its head, and each contact its own edit and the overflow menu
 * (delete in the setup phase, void after go-live: the correction ledger keeps the old list either way).
 * Each write replaces the list through PATCH /employees/{id} (`emergency_contacts`), a quick edit with undo.
 */
export function EmergencyContacts({ c, quick }: { c: Card; quick: Quick }) {
  // The palette's contact add opens the card with ?act=contact.add (Back closes it).
  const { act } = route.useSearch();
  const navigate = route.useNavigate();
  const [state, setOpen] = useState<{ at: number | null } | null>(null);
  const open = state ?? (act === "contact.add" ? { at: null } : null);
  const close = () => (setOpen(null), act === "contact.add" && void navigate({ search: (x) => ({ ...x, act: undefined }), replace: true }));
  const list = c.personal.data?.emergency_contacts ?? [];
  const items = list.map(toInput);
  // The list is written at the version of the read that drew it (the personal facts), as the career rows are.
  const at = c.personal.data?.updated_at ?? c.e.updated_at;
  const label = t("empCard.f.emergency");
  const who = (x: Contact) => `${t(`empCard.relation.${x.relation}`)} ${Array.from(x.name)[0] ?? ""}••`;
  const full = list.length >= MAX ? t("empContact.full", { max: MAX }) : undefined;
  return (
    <>
      <FieldRow
        id="f-emergency"
        label={label}
        sub={t("empCard.emergency.count", { count: list.length })}
        mark={c.editable && <ListAdd object={label} onAdd={() => setOpen({ at: null })} why={full} />}
      >
        {list.length ? (
          <ul className={s.contacts} aria-label={label}>
            {list.map((x, i) => (
              <li key={`${x.relation}-${x.phone}-${i}`} className={s.contact}>
                <span>{who(x)} · {maskedPhone(x.phone)}{!x.contact_notified ? ` · ${t("empContact.need.notice")}` : ""}{x.basis && x.recorded_by && x.recorded_at ? ` · ${t("empContact.recorded", { basis: basisLabel(x.basis), label: t("empContact.basis.label"), by: actor(x.recorded_by_name), at: fmtDateTime(x.recorded_at) })}` : ""}</span>
                {c.editable && (
                  <RowActions
                    field={t("empContact.of", { who: who(x) })}
                    onEdit={() => setOpen({ at: i })}
                    end={{ verb: c.setup ? "delete" : "void", onPress: () => quick.save(label, { emergency_contacts: items.filter((_, j) => j !== i) }, { emergency_contacts: items }, at) }}
                  />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Muted>{t("empCard.none")}</Muted>
        )}
      </FieldRow>
      {open && <ContactSheet c={c} list={list} at={open.at} onClose={close} />}
    </>
  );
}

/** One contact added or edited: name, relation (no default), mobile, and confirmation that the contact was told; the rest of the list goes back unchanged. */
export function ContactSheet({
  c,
  list,
  at,
  onClose,
  initialDraft,
}: {
  c: Card;
  list: Contact[];
  at: number | null;
  onClose: () => void;
  initialDraft?: { name?: string; relation?: Contact["relation"] | ""; phone?: string; notified?: boolean; tried?: boolean };
}) {
  const before = at === null ? null : list[at]!;
  const [name, setName] = useState(initialDraft?.name ?? before?.name ?? "");
  const [relation, setRelation] = useState<Contact["relation"] | "">(initialDraft?.relation ?? before?.relation ?? "");
  const [phone, setPhone] = useState(initialDraft?.phone ?? (before ? toDomestic(before.phone) : ""));
  const [notified, setNotified] = useState(initialDraft?.notified ?? false);
  const [tried, setTried] = useState(initialDraft?.tried ?? false);
  const e164 = phone ? phoneE164(phone) : null;
  const plan = buildEmergencyContactWrite(list, at, { name, relation, phone, notified });
  const ready = plan.ok;
  const run = useCommand({
    run: () => {
      if (!plan.ok) throw new Error(plan.code);
      return correctEmployee(c.e.id, c.personal.data?.updated_at ?? c.e.updated_at, { emergency_contacts: plan.contacts }, QUICK);
    },
    invalidates: ["/api/v1/employees"],
    settle: true,
    onSuccess: onClose,
    announce: () => t(at === null ? "empContact.added" : "empContact.saved"),
  });
  const title = t(at === null ? "empContact.add" : "empContact.edit");
  return (
    <Composer
      open
      kicker={<Who c={c} />}
      title={title}
      onClose={onClose}
      pending={run.isPending}
      notice={run.isError && <CommandError error={run.error} own={(code) => (code === EMERGENCY_CONTACT_REFUSAL_CODE ? t("empContact.need.notice") : undefined)} />}
      consequence={<PathNote path={c.setup ? "setup" : "correction"} />}
      action={{ kind: "profile", mode: "correct", count: 1 }}
      incomplete={!ready}
      onSubmit={() => (ready ? run.mutate(undefined) : setTried(true))}
    >
      <Field label={t("empContact.name")} required error={tried && !name.trim() ? t("empContact.need.name") : undefined}>
        {(p) => <TextInput {...p} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label={t("empContact.relation")} required error={tried && !relation ? t("empContact.need.relation") : undefined}>
        {(p) => (
          <SelectInput {...p} value={relation} onChange={(e) => setRelation(e.target.value as Contact["relation"])}>
            <option value="" disabled>{t("empContact.relation.pick")}</option>
            {RELATIONS.map((r) => <option key={r} value={r}>{t(`empCard.relation.${r}`)}</option>)}
          </SelectInput>
        )}
      </Field>
      <MaskedField label={t("empContact.phone")} required format={FORMATS.phone} value={phone} onChange={setPhone} error={tried && !e164 ? t("empContact.need.phone") : undefined} />
      <Field
        label={t("empContact.notice.label")}
        required
        tag={<Muted>{t("empContact.basis.notice")}</Muted>}
        error={tried && !notified ? t("empContact.need.notice") : undefined}
      >
        {() => <Check checked={notified} onChange={setNotified}>{t("empContact.notice.confirm")}</Check>}
      </Field>
    </Composer>
  );
}
