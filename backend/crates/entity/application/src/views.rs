//! Read views (wire shapes). Identifiers are sent canonical with a display
//! form beside them, so the client never re-implements a mask it can get wrong.

use console_entity_domain::KrAddress;
use console_entity_domain::codes::{
    BizKind, BrnPendingReason, CloseReason, DirectorRole, InsuranceStatus, InsuranceUnitMode,
    Insurer, NtsTaxType, OperatingStatus, RepresentationMode, UnverifiedReason, VatUnitBasis,
    VatUnitMode, WithholdingMode,
};
use console_entity_domain::legal_entity::CodeRef;
use console_entity_domain::refusal::Warning;
use console_entity_domain::workplace::WithholdingTarget;
use serde::Serialize;
use uuid::Uuid;

/// Canonical digits plus the masked form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Formatted {
    pub value: String,
    pub display: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LegalEntityView {
    #[serde(flatten)]
    pub read: crate::ReadStamp,
    pub id: Uuid,
    pub biz_kind: Option<BizKind>,
    pub crn: Option<Formatted>,
    pub needs_confirmation: bool,
    pub identity_locked: bool,
    /// 설립 중: recorded before its 설립등기 (no 법인등록번호 yet).
    pub founding: bool,
    /// Whether the reader may manage this 법인 itself (Cedar
    /// `legal_entity_manage` within their scope): edit verbs are offered only
    /// then. Set by the REST face; `false` from the store.
    pub can_manage: bool,
    #[serde(with = "crate::iso_date::option")]
    pub closed_on: Option<time::Date>,
    /// Why it closed (해산 / 폐업); set with `closed_on`.
    pub close_reason_code: Option<CloseReason>,
    pub primary_workplace_id: Option<Uuid>,
    pub head_office_workplace_id: Option<Uuid>,
    pub head_office_has_no_workplace: bool,
    pub identity_problems: Vec<Warning>,
    /// Open one-time reviews: a registration 상호 that differed from the name
    /// when the name became single-source. Personal readers only.
    pub name_reviews: Vec<NameReview>,
    pub current: Option<LegalEntityState>,
    /// Revisions dated after today (KST), oldest first.
    pub scheduled: Vec<LegalEntityState>,
    pub registrations: Vec<RegistrationView>,
    pub workplaces: Vec<WorkplaceView>,
    /// 상시근로자 수 of the 법인 (the 근기법 unit by default, 대법원 2023두57876).
    pub regular_workers: crate::RegularWorkers,
}

#[derive(Debug, Clone, Serialize)]
pub struct NameReview {
    pub id: Uuid,
    pub registration_id: Uuid,
    pub entity_name: String,
    pub registration_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LegalEntityState {
    pub version: i32,
    #[serde(with = "crate::iso_date")]
    pub effective_from: time::Date,
    /// The as-of date is before the first record: this is that first record
    /// (INTEG-3), shown so the screen is never blank before 개업일.
    pub before_first_record: bool,
    pub name: String,
    pub display_name: Option<String>,
    pub english_name: Option<String>,
    pub representation_mode: Option<RepresentationMode>,
    /// Omitted (`null`) for callers without the restricted-read permission.
    pub representatives: Option<Vec<String>>,
    pub additional_representatives: i32,
    pub head_office_address: Option<KrAddress>,
    #[serde(with = "crate::iso_date::option")]
    pub incorporated_on: Option<time::Date>,
    pub fiscal_year_end_month: Option<i16>,
    pub capital_won: Option<i64>,
    /// 임원 (상법 §317②8), printed order. Omitted (`null`) for callers
    /// without the restricted-read permission, like the representatives.
    pub directors: Option<Vec<DirectorView>>,
    pub vat_unit_mode: Option<VatUnitMode>,
    pub vat_unit_mode_basis: Option<VatUnitBasis>,
    pub main_ksic: Option<CodeRef>,
    pub main_phone: Option<Formatted>,
    pub priority_support: Option<String>,
    pub priority_support_basis: Option<String>,
    pub large_group_member: Option<bool>,
    pub change_mode: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirectorView {
    pub role: DirectorRole,
    pub name: String,
    #[serde(with = "crate::iso_date::option")]
    pub appointed_on: Option<time::Date>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegistrationView {
    pub id: Uuid,
    pub legal_entity_id: Uuid,
    pub brn: Option<Formatted>,
    pub brn_pending_reason: Option<BrnPendingReason>,
    pub holder_workplace_id: Option<Uuid>,
    pub verification_tier: String,
    pub voided: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nts_check: Option<crate::registration_check::CheckEvidence>,
    pub unverified_reason: Option<UnverifiedReason>,
    pub needs_confirmation: bool,
    pub identity_locked: bool,
    #[serde(with = "crate::iso_date::option")]
    pub closed_on: Option<time::Date>,
    pub current: Option<RegistrationState>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegistrationState {
    pub version: i32,
    #[serde(with = "crate::iso_date")]
    pub effective_from: time::Date,
    /// The as-of date is before the first record: this is that first record
    /// (INTEG-3), shown so the screen is never blank before 개업일.
    pub before_first_record: bool,
    /// INDIVIDUAL: the certificate's own 상호 (legacy NULL falls back to the entity name).
    /// Other kinds: the entity's 법인명, derived.
    pub trade_name: String,
    pub classification_reason: Option<String>,
    #[serde(with = "crate::iso_date::option")]
    pub opened_on: Option<time::Date>,
    pub business_address: Option<KrAddress>,
    pub business_types: Vec<BusinessTypeView>,
    pub unit_taxation: Option<bool>,
    pub tax_type: Option<NtsTaxType>,
    pub tax_office_code: Option<String>,
    pub tax_office_label: Option<String>,
    pub issue_reason_kind: Option<String>,
    pub issue_reason_sub: Option<String>,
    pub issue_reason_as_printed: Option<String>,
    #[serde(with = "crate::iso_date::option")]
    pub cert_issued_on: Option<time::Date>,
    pub e_invoice_email: Option<String>,
    pub liquor_license_no: Option<String>,
    pub production_factor: Option<String>,
    pub co_owners: Option<Vec<String>>,
    pub status: OperatingStatus,
    #[serde(with = "crate::iso_date::option")]
    pub status_since: Option<time::Date>,
    /// 휴업's expected end, as reported (SUSPENDED only).
    #[serde(with = "crate::iso_date::option")]
    pub status_until: Option<time::Date>,
    pub change_mode: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BusinessTypeView {
    pub is_main: bool,
    pub sector_as_printed: String,
    pub item_as_printed: String,
    pub nts_code: Option<String>,
    pub ksic: Option<CodeRef>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkplaceView {
    /// First date both the workplace and its employer exist, shared with placement admission.
    #[serde(with = "crate::iso_date::option")]
    pub placement_opens_on: Option<time::Date>,
    #[serde(flatten)]
    pub read: crate::ReadStamp,
    pub id: Uuid,
    pub legal_entity_id: Uuid,
    pub registration_id: Option<Uuid>,
    pub sub_serial: Option<String>,
    pub not_registered_reason: Option<CodeRef>,
    pub is_abstract: bool,
    /// The only registration warning state: no registration, no completed
    /// not-required answer, and not an abstract workplace.
    pub registration_todo: bool,
    pub filing_registration_id: Option<Uuid>,
    pub default_branch_id: Option<Uuid>,
    /// 사업장 kind code (decisions #18); `None` = 미지정.
    pub kind_code: Option<String>,
    /// 사업장 code (review R16): unique among open 사업장; `None` = none.
    pub code: Option<String>,
    pub is_primary: bool,
    pub is_head_office: bool,
    pub needs_confirmation: bool,
    /// Whether the reader may manage this 사업장 (set by the REST face).
    pub can_manage: bool,
    #[serde(with = "crate::iso_date::option")]
    pub closed_on: Option<time::Date>,
    pub current: Option<WorkplaceState>,
    pub insurance: Vec<InsuranceView>,
    pub withholding: WithholdingTarget,
    /// Active people assigned here today (KST).
    pub headcount: i64,
    /// The 사업장's own SITE org unit (decisions #14.1): register people with
    /// this `org_unit_id` to place them here with no 부서.
    pub org_unit_id: Option<Uuid>,
    /// 상시근로자 수 of this 사업장 (HOLD; BW-35).
    pub regular_workers: crate::RegularWorkers,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkplaceState {
    pub version: i32,
    #[serde(with = "crate::iso_date")]
    pub effective_from: time::Date,
    /// The as-of date is before the first record: this is that first record
    /// (INTEG-3), shown so the screen is never blank before 개업일.
    pub before_first_record: bool,
    pub name: String,
    pub address: Option<KrAddress>,
    pub mail_address: Option<KrAddress>,
    #[serde(with = "crate::iso_date::option")]
    pub opened_on: Option<time::Date>,
    pub representative_name: Option<String>,
    pub main_product: Option<String>,
    pub phone: Option<Formatted>,
    pub fax: Option<Formatted>,
    pub mobile: Option<Formatted>,
    pub email: Option<String>,
    pub is_construction_site: bool,
    pub is_abstract: bool,
    pub not_registered_reason: Option<CodeRef>,
    pub status: OperatingStatus,
    #[serde(with = "crate::iso_date::option")]
    pub status_since: Option<time::Date>,
    /// 휴업's expected end, as reported (SUSPENDED only).
    #[serde(with = "crate::iso_date::option")]
    pub status_until: Option<time::Date>,
    pub withholding_mode: Option<WithholdingMode>,
    #[serde(with = "crate::iso_date::option")]
    pub bulk_filed_on: Option<time::Date>,
    pub independent_lsa_unit: Option<bool>,
    /// Why this 사업장 is its own 근기법 unit (required while flagged); sent
    /// back so a revise can resend it (MR-6).
    pub independent_lsa_evidence: Option<String>,
    pub change_mode: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InsuranceView {
    pub insurer: Insurer,
    pub version: i32,
    #[serde(with = "crate::iso_date")]
    pub effective_from: time::Date,
    /// The as-of date is before the first record: this is that first record
    /// (INTEG-3), shown so the screen is never blank before 개업일.
    pub before_first_record: bool,
    pub status: InsuranceStatus,
    pub mgmt_no: Option<Formatted>,
    #[serde(with = "crate::iso_date::option")]
    pub established_on: Option<time::Date>,
    pub unit_mode: InsuranceUnitMode,
    pub main_workplace_id: Option<Uuid>,
}

/// A write's result: the record and its soft warnings (checksum, 상호 differs…).
#[derive(Debug, Clone, Serialize)]
pub struct Saved<T> {
    pub record: T,
    pub warnings: Vec<Warning>,
    pub change_mode: String,
}

/// One distinct legacy company text with no mapped 법인 (「회사 이름 정리」).
#[derive(Debug, Clone, Serialize)]
pub struct UnmappedCompany {
    pub company_text: String,
    pub employees: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssignmentView {
    pub id: Uuid,
    pub employee_id: Uuid,
    pub legal_entity_id: Option<Uuid>,
    pub workplace_id: Option<Uuid>,
    #[serde(with = "crate::iso_date")]
    pub valid_from: time::Date,
    #[serde(with = "crate::iso_date::option")]
    pub valid_to: Option<time::Date>,
    pub cause: String,
}
