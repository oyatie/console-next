import { checkState } from "../present";
// SPDX-License-Identifier: LicenseRef-Proprietary
import { Eye, Lock, Plus, TriangleAlert, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { ISSUE_REASON, label, TAX_TYPE } from "../../../lib/labels";
import { FORMATS } from "../../../lib/pure/formats";
import { AddressField } from "../../../ui/address-field/address-field";
import { Button, Check as Checkbox } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Chip } from "../../../ui/chip";
import { Field, Marker, TextInput } from "../../../ui/field/field";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { QueryState } from "../../../lib/react/query-state";
import { useAddressSearch, useCodeLists } from "./use-ref";
import { BusinessRows } from "./create-business-rows";
import { DistrictPick } from "./district-pick";
import { Item } from "./create-item";
import { problem } from "../present";
import { createRequirements } from "../domain/create";
import { TaxOffice } from "./create-tax-office";
import type { CreateState } from "./use-create";
import { BrnConfirm } from "./brn-confirm";
import { brnWarningText, openedWarningText } from "../present";
import s from "./entity-create.module.css";

// taxpayer type as printed in the certificate's title brackets, per certificate kind (enum.taxType).
const CORP_TAX = ["01", "02", "04", "05", "06"] as const;
const IND_TAX = ["01", "02", "07", "04"] as const;
const CERT_LISTS = ["ksic", "admin_region", "tax_office"] as const;

/**
 * The business registration certificate typed as printed (form 7 (2), individual (1)): items numbered as on the certificate, empty ones
 * left as to-dos. A typed value that cannot be right refuses where it is typed and names the item to look at.
 */
export function CertForm({ c, onOpenTaken }: { c: CreateState; onOpenTaken?: () => void }) {
  const { draft: d, put, problems: p } = c;
  const requirements = createRequirements(d);
  const required = new Set([...requirements.entity, ...requirements.registration]);
  const ind = d.bizKind === "INDIVIDUAL";
  const place = useAddressSearch();
  const head = useAddressSearch();
  const reps = d.representatives;
  // The industry code (item 7), the districts (items 5 and 6) and the tax office: their shape waits for their lists.
  const lists = useCodeLists(CERT_LISTS);
  return (
    <QueryState q={lists}>{() => <div className={s.grid}>
      <div className={s.span}>
        <ChoiceField
          label={t("entityCreate.field.taxType")}
          required={required.has("taxType")}
          options={(ind ? IND_TAX : CORP_TAX).map((v) => ({ value: v, label: label(TAX_TYPE, v) }))}
          value={d.taxType}
          onChange={(v) => put("taxType", v as typeof d.taxType)}
        />
      </div>
      <MaskedField
        label={t("entityCreate.field.brn")}
        required={required.has("brn")}
        format={FORMATS.bizRegNo}
        value={d.brn}
        onChange={(v) => put("brn", v)}
        error={p.brn && <BrnProblem c={c} onOpen={onOpenTaken} />}
        warning={p.brn ? undefined : brnWarningText(d, c.brnClasses)}
        hint={t("entityCreate.brn.hint")}
        status={<Chip tone={checkState(c.preview?.answer, c.checkAvailability?.available).tone}>{checkState(c.preview?.answer, c.checkAvailability?.available).label}</Chip>}
      />
      <BrnConfirm brn={d.brn} confirmed={d.brnConfirmed} onConfirm={(v) => put("brnConfirmed", v)} />
      {!ind && (
        <Item no={4}>
          <MaskedField
            label={t("entityCreate.field.crn")}
            required={required.has("crn")}
            format={FORMATS.corpRegNo}
            value={d.crn}
            onChange={(v) => put("crn", v)}
            error={problem(p.crn)}
            warning={c.crnWarn ? t("entityCreate.problem.crnChecksum") : undefined}
          />
        </Item>
      )}
      <Field label={t("entity.name.classificationReason")} required={false}>{(f) => <TextInput {...f} maxLength={1000} value={d.classificationReason} onChange={(x) => put("classificationReason", x.target.value)} />}</Field>
      <Item no={1}>
        <Field label={t(ind ? "entityCreate.field.tradeName" : "entityCreate.field.corpName")} required={required.has("name")}>
          {(f) => <TextInput {...f} maxLength={200} value={d.name} onChange={(e) => put("name", e.target.value)} />}
        </Field>
      </Item>
      <Item no={2}>
        <div className={s.reps}>
          {reps.map((n, i) => (
            <Field key={i} label={t(ind ? "entityCreate.field.ownerName" : i === 0 ? "entityCreate.field.representative" : "entityCreate.field.representativeN", { n: i + 1 })} required={i === 0 && required.has("representatives")}>
              {(f) => (
                <span className="row">
                  <TextInput {...f} className="grow" maxLength={100} value={n} onChange={(e) => put("representatives", reps.map((x, j) => (j === i ? e.target.value : x)))} />
                  {i > 0 && <Button variant="ghost" aria-label={t("entityCreate.field.removeRepresentative", { n: i + 1 })} onClick={() => put("representatives", reps.filter((_, j) => j !== i))}><X size={16} aria-hidden /></Button>}
                  {!ind && i === reps.length - 1 && <Button onClick={() => put("representatives", [...reps, ""])}><Plus size={16} aria-hidden /> {t("entityCreate.field.addRepresentative")}</Button>}
                </span>
              )}
            </Field>
          ))}
        </div>
      </Item>
      <Item no={3}>
        <DateField label={t("entityCreate.field.openedOn")} required={required.has("openedOn")} value={d.openedOn} onChange={(v) => put("openedOn", v)} today={c.today} error={p.openedOn && t("entityCreate.problem.futureOpened", { date: fmtDate(c.today) })} remedy={p.openedOn ? undefined : openedWarningText(d)} />
      </Item>
      {ind && (
        <Item no={4}>
          <Field label={t("entityCreate.field.birthDate")} required={false}>
            {(f) => <span className={s.locked}><TextInput {...f} readOnly value={t("entityCreate.field.notCollected")} /><Lock size={16} aria-hidden /></span>}
          </Field>
        </Item>
      )}
      <Item no={ind ? 7 : 8}>
        <ChoiceField
          label={t("entityCreate.field.issueReason")}
          required={false}
          options={ISSUE_REASON.values.map((v) => ({ value: v, label: label(ISSUE_REASON, v) }))}
          value={d.issueReason}
          onChange={(v) => put("issueReason", v as typeof d.issueReason)}
        />
      </Item>
      <Item no={5} span>
        <AddressField label={t("entityCreate.field.businessAddress")} required={required.has("businessAddress")} value={d.businessAddress} onChange={(v) => put("businessAddress", v && place.withCodes(v))} query={place.query} onQueryChange={place.setQuery} hits={place.hits} loading={place.loading} problem={place.problem} />
        <DistrictPick a={d.businessAddress} onChange={(a) => put("businessAddress", a)} />
      </Item>
      {!ind && (
        <Item no={6} span>
          <Checkbox checked={d.headOffice === "SAME"} onChange={(on) => put("headOffice", on ? "SAME" : "OTHER")}>{t("entityCreate.field.headOfficeSame")}<Marker required={required.has("headOffice")} /></Checkbox>
          {d.headOffice !== "SAME" && (
            <>
              <AddressField label={t("entityCreate.field.headOfficeAddress")} required={required.has("headOffice")} value={d.headOfficeAddress} onChange={(v) => put("headOfficeAddress", v && head.withCodes(v))} query={head.query} onQueryChange={head.setQuery} hits={head.hits} loading={head.loading} problem={head.problem} />
              <DistrictPick a={d.headOfficeAddress} onChange={(a) => put("headOfficeAddress", a)} />
            </>
          )}
        </Item>
      )}
      <Item no={ind ? 6 : 7} span>
        <span className="field__label">{t("entityCreate.field.business")}<Marker required={required.has("businessTypes")} /></span>
        <BusinessRows rows={d.businessTypes} onChange={(r) => put("businessTypes", r)} />
      </Item>
      {ind && (
        <Item no={8}>
          <Field label={t("entityCreate.field.coOwners")} required={false} hint={t("entity.field.coOwnersHint")}>
            {(f) => <TextInput {...f} value={d.coOwners.join(", ")} onChange={(e) => put("coOwners", e.target.value.split(/[,·]/).map((x) => x.trimStart()))} />}
          </Field>
        </Item>
      )}
      {ind && (
        <Item no={9}>
          <Field label={t("entityCreate.field.liquor")} required={false}>
            {(f) => <TextInput {...f} value={d.liquorLicenseNo} onChange={(e) => put("liquorLicenseNo", e.target.value)} />}
          </Field>
        </Item>
      )}
      <Item no={10}>
        <ChoiceField
          label={t("entityCreate.field.unitTaxation")}
          required={required.has("unitTaxation")}
          options={[{ value: "Y", label: t("entityCreate.unitTaxation.yes") }, { value: "N", label: t("entityCreate.unitTaxation.no") }]}
          value={d.unitTaxation === null ? null : d.unitTaxation ? "Y" : "N"}
          onChange={(v) => put("unitTaxation", v === "Y")}
          hint={d.unitTaxation === null ? t("entityCreate.field.unitTaxationHint") : undefined}
        />
      </Item>
      <Item no={11}>
        <Field label={t("entityCreate.field.eInvoiceEmail")} required={false} error={problem(p.eInvoiceEmail)}>
          {(f) => <TextInput {...f} type="email" autoComplete="off" value={d.eInvoiceEmail} onChange={(e) => put("eInvoiceEmail", e.target.value)} />}
        </Field>
      </Item>
      {!ind && (
        <Item no={9}>
          <Field label={t("entityCreate.field.liquor")} required={false}>
            {(f) => <TextInput {...f} value={d.liquorLicenseNo} onChange={(e) => put("liquorLicenseNo", e.target.value)} />}
          </Field>
        </Item>
      )}
      <DateField label={t("entityCreate.field.certIssuedOn")} required={false} value={d.certIssuedOn} onChange={(v) => put("certIssuedOn", v)} today={c.today} error={problem(p.certIssuedOn)} />
      <TaxOffice c={c} />
    </div>}</QueryState>
  );
}


/** A BRN that cannot be saved: why, and for a taken one, the two ways out (open that certificate, look again). */
function BrnProblem({ c, onOpen }: { c: CreateState; onOpen?: () => void }) {
  if (c.problems.brn !== "brnTaken" || !c.taken) return <>{problem(c.problems.brn)}</>;
  const where = c.taken.holder ? `${c.taken.entity} › ${c.taken.holder}` : c.taken.entity;
  return (
    <span className={s.problem}>
      <span><TriangleAlert size={14} aria-hidden /> {t("entityCreate.problem.brnTaken", { where })}</span>
      <span className="row">
        <Link to="/org/entities/$id" params={{ id: c.taken.entityId }} className="btn btn--ghost" onClick={onOpen}><Eye size={16} aria-hidden /> {t("entityCreate.brn.openTaken")}</Link>
        <Button variant="ghost" onClick={() => c.put("brn", "")}>{t("entityCreate.brn.retype")}</Button>
      </span>
    </span>
  );
}
