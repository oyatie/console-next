// Reading a legal entity as the server returns it (its current state, registrations and workplaces), and
// turning its current state back into the full input a dated revision sends. Pure.
import type { KrAddress, LegalEntity, LegalEntityInput, RegistrationInput, Workplace, WorkplaceInput } from "@console/api/pending";

export const workplaceName = (w: Workplace) => w.current?.name ?? "";
export const registrationOf = (e: LegalEntity, id?: string | null) => (id ? e.registrations.find((r) => r.id === id) : undefined);
/** The representative workplace's certificate, else the first one. */
export const primaryRegistration = (e: LegalEntity) => registrationOf(e, e.workplaces.find((w) => w.is_primary)?.registration_id) ?? e.registrations[0];
export const headcount = (e: LegalEntity) => e.workplaces.reduce((n, w) => n + w.headcount, 0);
export const registrationTodo = (w: Workplace) => w.registration_todo;
/** Certificates entered for the entity that no workplace holds yet (the first one, until its workplace exists). */
export const unheld = (e: LegalEntity) => e.registrations.filter((r) => !r.holder_workplace_id && !r.closed_on);
/** The entity's unit-taxation registration, whose sub-workplaces carry a serial. */
export const unitRegistration = (e: LegalEntity) => e.registrations.find((r) => r.current?.unit_taxation && !r.closed_on);
/** Whether the head office is settled: a workplace is it, or it is an office only. */
export const headOfficeSettled = (e: LegalEntity) => Boolean(e.head_office_workplace_id) || e.head_office_has_no_workplace;
export const addressLine = (a?: KrAddress | null) => (a ? [a.road_addr_part1, a.detail, a.road_addr_part2].filter(Boolean).join(" ") : "");
/** Same place, judged by the building number when both came from the search, else by the road address text. */
export const samePlace = (a?: KrAddress | null, b?: KrAddress | null) =>
  Boolean(a && b && (a.bd_mgt_sn && b.bd_mgt_sn ? a.bd_mgt_sn === b.bd_mgt_sn : a.road_addr_part1.trim() === b.road_addr_part1.trim()));

/**
 * The entity's current state (or `c`, another of its states) as a full input, for a dated revision to change. Null
 * when the caller may not read the representatives (restricted), since a revision would otherwise erase them.
 */
export function entityInput(e: LegalEntity, c: LegalEntity["current"] = e.current): LegalEntityInput | null {
  if (!c || !e.biz_kind || !c.representatives) return null;
  return {
    biz_kind: e.biz_kind,
    name: c.name,
    display_name: c.display_name ?? null,
    english_name: c.english_name,
    representation_mode: c.representation_mode ?? "SINGLE",
    representatives: c.representatives,
    additional_representatives: c.additional_representatives,
    crn: e.crn?.value ?? null,
    head_office_address: c.head_office_address ?? null,
    incorporated_on: c.incorporated_on ?? null,
    fiscal_year_end_month: c.fiscal_year_end_month ?? null,
    capital_won: c.capital_won ?? null,
    // Omitted keeps the current officers on the server; a revision that changes them sends the new list.
    directors: undefined,
    // A derived VAT unit is not a declaration: only a declared one is sent back.
    vat_unit_mode: c.vat_unit_mode_basis === "DECLARED" ? (c.vat_unit_mode ?? null) : null,
    main_ksic: c.main_ksic ?? null,
    main_phone: c.main_phone?.value ?? null,
    priority_support: (c.priority_support as LegalEntityInput["priority_support"]) ?? null,
    priority_support_basis: (c.priority_support_basis as LegalEntityInput["priority_support_basis"]) ?? null,
    large_group_member: c.large_group_member ?? null,
  };
}

/** A registration's current state as a full input (null before it has one). */
export function registrationInput(e: LegalEntity, id: string): RegistrationInput | null {
  const r = registrationOf(e, id);
  const c = r?.current;
  if (!r || !c || !c.opened_on || !c.business_address || c.unit_taxation == null || !c.tax_office_label || !c.tax_type) return null;
  return {
    ...(e.biz_kind === "INDIVIDUAL" ? { trade_name: c.trade_name } : {}),
    brn: r.brn?.value ?? null,
    classification_reason: c.classification_reason,
    opened_on: c.opened_on,
    business_address: c.business_address,
    business_types: c.business_types.map((b) => ({ is_main: b.is_main, sector: b.sector_as_printed, item: b.item_as_printed, nts_code: b.nts_code ?? null, ksic: b.ksic ?? null })),
    production_factor: c.production_factor ?? null,
    issue_reason_kind: (c.issue_reason_kind as RegistrationInput["issue_reason_kind"]) ?? null,
    issue_reason_sub: (c.issue_reason_sub as RegistrationInput["issue_reason_sub"]) ?? null,
    issue_reason_as_printed: c.issue_reason_as_printed ?? null,
    co_owners: c.co_owners ?? [],
    liquor_license_no: c.liquor_license_no ?? null,
    unit_taxation: c.unit_taxation,
    e_invoice_email: c.e_invoice_email ?? null,
    cert_issued_on: c.cert_issued_on ?? null,
    tax_office_code: c.tax_office_code ?? null,
    tax_office_label: c.tax_office_label,
    tax_type: c.tax_type,
  };
}

/** A workplace's current state as a full input (null before it has one). */
export function workplaceInput(e: LegalEntity, w: Workplace): WorkplaceInput | null {
  const c = w.current;
  if (!c || !c.opened_on) return null;
  const holds = Boolean(w.registration_id) && registrationOf(e, w.registration_id)?.holder_workplace_id === w.id;
  const reason = w.not_registered_reason;
  return {
    name: c.name,
    registration_id: w.registration_id ?? null,
    sub_serial: w.sub_serial ?? null,
    reg_mode: w.registration_id ? "EXISTING" : reason ? "NOT_REQUIRED" : "LATER",
    not_registered_reason: reason
      ? { code: reason.code, version: reason.version }
      : null,
    is_abstract: w.is_abstract ?? false,
    same_address_as_registration: holds,
    address: holds ? null : (c.address ?? null),
    mail_address: c.mail_address ?? null,
    opened_on: c.opened_on,
    representative_name: c.representative_name ?? null,
    main_product: c.main_product ?? null,
    phone: c.phone?.value ?? null,
    fax: c.fax?.value ?? null,
    mobile: c.mobile?.value ?? null,
    email: c.email ?? null,
    is_construction_site: c.is_construction_site,
    withholding_mode: c.withholding_mode ?? null,
    bulk_filed_on: c.bulk_filed_on ?? null,
    independent_lsa_unit: c.independent_lsa_unit ?? null,
    independent_lsa_evidence: c.independent_lsa_evidence ?? null,
    status: c.status,
    status_since: c.status_since ?? null,
    // A suspension's expected end rides along with any other revision of the workplace (never cleared unasked).
    status_until: c.status_until ?? null,
  };
}
