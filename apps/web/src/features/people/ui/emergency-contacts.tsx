import { useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { FORMATS, phoneE164, toDomestic } from "../../../lib/pure/formats";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
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
        mark={c.manage && <ListAdd object={label} onAdd={() => setOpen({ at: null })} why={full} />}
      >
        {list.length ? (
          <ul className={s.contacts} aria-label={label}>
            {list.map((x, i) => (
              <li key={`${x.relation}-${x.phone}-${i}`} className={s.contact}>
                <span>{who(x)} · {maskedPhone(x.phone)}</span>
                {c.manage && (
                  <RowActions
                    field={t("empContact.of", { who: who(x) })}
                    onEdit={() => setOpen({ at: i })}
                    end={{ verb: c.setup ? "delete" : "void", onPress: () => quick.save(label, { emergency_contacts: list.filter((_, j) => j !== i) }, { emergency_contacts: list }, at) }}
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

/** One contact added or edited: name, relation (no default), mobile; the rest of the list goes back unchanged. */
function ContactSheet({ c, list, at, onClose }: { c: Card; list: Contact[]; at: number | null; onClose: () => void }) {
  const before = at === null ? null : list[at]!;
  const [name, setName] = useState(before?.name ?? "");
  const [relation, setRelation] = useState<Contact["relation"] | "">(before?.relation ?? "");
  const [phone, setPhone] = useState(before ? toDomestic(before.phone) : "");
  const [tried, setTried] = useState(false);
  const e164 = phone ? phoneE164(phone) : null;
  const ready = name.trim() !== "" && relation !== "" && e164 !== null;
  const next: Contact[] = ready ? (at === null ? [...list, { name: name.trim(), relation, phone: e164 }] : list.map((x, i) => (i === at ? { name: name.trim(), relation, phone: e164 } : x))) : list;
  const run = useCommand({
    run: () => correctEmployee(c.e.id, c.personal.data?.updated_at ?? c.e.updated_at, { emergency_contacts: next }, QUICK),
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
      notice={run.isError && <CommandError error={run.error} />}
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
    </Composer>
  );
}
