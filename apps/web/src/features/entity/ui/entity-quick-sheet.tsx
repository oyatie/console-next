import { entityName, latinName, legalNameTaken, personName } from "../../../reference/entity/domain/names";
import { buttonClass } from "../../../ui/button/button-class";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, ClipboardPaste, FileText, Upload } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { BizKind } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { entitiesRef } from "../../../reference/entity/api";
import { Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { Sheet } from "../../../ui/sheet/sheet";
import { createEntity, ENTITY_READS } from "../api";
import { emptyDraft } from "../domain/draft";
import { entityBody, entityGaps } from "../domain/create";
import { KindAndName, OtherNames } from "./create-kind-and-name";
import s from "./entity-create.module.css";

export type QuickSaved = { id: string; name: string };

/**
 * add entity from the chart's root box (spec S4-quick, OM §3.6): which certificate, the name and the representative. The rest
 * stays on the box as to-dos. The full certificate wizard carries what was chosen here.
 * `onSaved` lets the caller show the receipt with its undo.
 */
export function EntityQuickSheet({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (r: QuickSaved, then: "stay" | "workplace") => void }) {
  const [kind, setKind] = useState<BizKind | null>(null);
  const [name, setName] = useState("");
  const [rep, setRep] = useState("");
  const [alias, setAlias] = useState("");
  const [english, setEnglish] = useState("");
  const why = useId();
  const nav = useNavigate();
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const n = entities.filter((e) => !e.closed_on).length + 1;
  const clash = legalNameTaken(name, entities);
  const draft = { ...emptyDraft(), bizKind: kind, name, representatives: [rep], displayName: alias, englishName: english };
  const gaps = entityGaps(draft);
  // The server still asks a corporation for its CRN and head office before it records one (CS-BE); say so and offer the certificate.
  const hold = personName(name, [rep]) ? t("entity.refusal.legal_name_is_person") : alias.trim() && personName(alias.trim(), [rep]) ? t("entity.refusal.display_name_is_person")
    : english.trim() && (!latinName(english.trim()) || personName(english.trim(), [rep])) ? t(latinName(english.trim()) ? "entity.refusal.english_name_is_person" : "entity.refusal.english_name_not_latin") : !kind || !name.trim() || !rep.trim() ? t("entityQuick.hold.basics") : gaps.length ? t("entityQuick.hold.corp") : null;
  const save = useCommand({
    run: (_then: "stay" | "workplace", key: string) => createEntity(key, entityBody(draft)),
    invalidates: ENTITY_READS,
    settle: true,
    announce: (r) => t("entityCreate.saved", { name: entityName(r.record) }),
    onSuccess: (r, then) => {
      setKind(null);
      setName("");
      setRep("");
      setAlias("");
      setEnglish("");
      onSaved({ id: r.record.id, name: entityName(r.record) }, then);
    },
  });
  const off = hold ? { "aria-disabled": true as const, "aria-describedby": why } : {};
  const go = (then: "stay" | "workplace") => !hold && save.mutate(then);
  const full = () => void nav({ to: "/org/entities/new", search: { kind: kind ?? undefined, name: name.trim() || undefined } });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      pending={save.isPending}
      title={t("entityQuick.title")}
      subtitle={<span className={s.kicker}><Building2 size={14} aria-hidden /> {t("entityQuick.kicker", { n })}</span>}
      notice={<EntityError error={save.error} />}
      consequence={<span id={why}>{hold ?? t("entityQuick.consequence", { name: name.trim() })}</span>}
      actions={
        <>
          <Button onClick={onClose}>{t("entityQuick.cancel")}</Button>
          <Button {...off} onClick={() => go("workplace")}>{t("entityQuick.createAndWorkplace")}</Button>
          <Button variant="primary" {...off} onClick={() => go("stay")}>{t("entityQuick.create")}</Button>
        </>
      }
    >
      <KindAndName representatives={[rep]} kind={kind} onKind={setKind} name={name} onName={setName} clash={clash} />
      {/* The optional names follow the legal name, never the representative's box. */}
      <OtherNames representatives={[rep]} displayName={alias} onDisplayName={setAlias} englishName={english} onEnglishName={setEnglish} />
      {/* The server also requires a named representative (CS-BE). */}
      <Field label={t(kind === "INDIVIDUAL" ? "entityCreate.field.ownerName" : "entityCreate.field.representative")} required >
        {(f) => <TextInput {...f} maxLength={100} autoComplete="off" value={rep} onChange={(e) => setRep(e.target.value)} />}
      </Field>
      <div className="form__actions">
          <Button onClick={full}><FileText size={16} aria-hidden /> {t("entityQuick.full")}</Button>
          <Link to="/org/entities/bulk" search={{ mode: "paste" }} className={buttonClass()}><ClipboardPaste size={16} aria-hidden /> {t("entityQuick.paste")}</Link>
          <Link to="/org/entities/bulk" search={{ mode: "import" }} className={buttonClass()}><Upload size={16} aria-hidden /> {t("entityQuick.import")}</Link>
      </div>
    </Sheet>
  );
}
