//! 사업장 views: current revision, current 4대보험 per insurer, derived
//! withholding unit and today's headcount.

use std::collections::HashMap;

use console_entity_application::{
    Formatted, InsuranceView, ReadOptions, ReadPoint, RegularWorkers, WorkplaceState, WorkplaceView,
};
use console_entity_domain::codes::{
    BizKind, InsuranceStatus, InsuranceUnitMode, Insurer, OperatingStatus, WithholdingMode,
};
use console_entity_domain::workplace::{WithholdingFacts, withholding_target};
use console_kernel_core::kr::InsuranceMgmtNo;
use sqlx::Row;
use uuid::Uuid;

use crate::address::load_addresses;
use crate::read::fmt_phone;
use crate::{PgEntityError, Tx};

/// Every non-voided 사업장 of `entities`, keyed by entity. The 사업장's own
/// 대표자, 휴대전화 and 이메일 are personal: only for `personal` callers
/// (INTEG-6, the same rule as the entity's 대표자).
pub(crate) async fn views(
    tx: &mut Tx<'_>,
    entities: &[Uuid],
    granted: Option<&[Uuid]>,
    today: time::Date,
    personal: bool,
) -> Result<HashMap<Uuid, Vec<WorkplaceView>>, PgEntityError> {
    views_at(
        tx,
        entities,
        granted,
        ReadPoint::new(today, ReadOptions::default()),
        personal,
    )
    .await
}

pub(crate) async fn views_at(
    tx: &mut Tx<'_>,
    entities: &[Uuid],
    granted: Option<&[Uuid]>,
    point: ReadPoint,
    personal: bool,
) -> Result<HashMap<Uuid, Vec<WorkplaceView>>, PgEntityError> {
    let rows = sqlx::query(
        "SELECT w.id, w.legal_entity_id, w.registration_id, w.sub_serial, w.default_branch_id, w.kind_code, w.code, w.needs_confirmation, \
                w.closed_on, w.not_registered_reason_code, w.not_registered_reason_label, w.not_registered_reason_version, \
                COALESCE(w.is_abstract, false) AS is_abstract, \
                COALESCE(w.registration_id, (SELECT reg.id FROM business_registrations reg WHERE reg.legal_entity_id = w.legal_entity_id AND reg.voided_at IS NULL AND reg.closed_on IS NULL ORDER BY reg.holder_workplace_id = e.primary_workplace_id DESC NULLS LAST, reg.created_at LIMIT 1)) AS filing_registration_id, \
                e.biz_kind, e.primary_workplace_id, e.head_office_workplace_id, e.head_office_has_no_workplace, \
                r.version, r.effective_from, r.name, r.address_id, r.mail_address_id, r.opened_on, r.representative_name, \
                r.main_product, r.phone, r.fax, r.mobile, r.email, r.is_construction_site, r.status, r.status_since, r.status_until, \
                r.withholding_mode, r.bulk_filed_on, r.independent_lsa_unit, r.independent_lsa_evidence, r.change_mode, r.effective_from > $2 AS before_first, \
                r.not_registered_reason_code AS rev_reason_code, r.not_registered_reason_label AS rev_reason_label, r.not_registered_reason_version AS rev_reason_version, \
                r.is_abstract AS rev_is_abstract, \
                (SELECT count(*) FROM employment_assignments a WHERE a.workplace_id = w.id \
                   AND (a.superseded_at IS NULL OR a.superseded_at > $4) \
                   AND ($4::timestamptz IS NULL OR a.created_at <= $4) \
                   AND a.valid_from <= $2 AND (a.valid_to IS NULL OR a.valid_to > $2 OR a.valid_to_recorded_at > $4)) AS headcount \
         FROM (SELECT (jsonb_populate_record(NULL::workplaces, entity_known_row(to_jsonb(b), $4))).* FROM workplaces b) w \
         JOIN (SELECT (jsonb_populate_record(NULL::legal_entities, entity_known_row(to_jsonb(b), $4))).* FROM legal_entities b) e ON e.id = w.legal_entity_id \
         LEFT JOIN LATERAL (SELECT * FROM workplace_revisions x WHERE x.workplace_id = w.id \
                            AND ($4::timestamptz IS NULL OR x.created_at <= $4) \
                            ORDER BY x.effective_from > $2, abs(x.effective_from - $2), x.version DESC LIMIT 1) r ON true \
         WHERE w.legal_entity_id = ANY($1) AND (w.voided_at IS NULL OR w.voided_at > $4) \
           AND ($4::timestamptz IS NULL OR w.created_at <= $4) \
           AND ($3::uuid[] IS NULL OR w.id = ANY($3) OR w.legal_entity_id = ANY($3)) ORDER BY w.sort_order NULLS LAST, w.created_at, w.id",
    )
    .bind(entities)
    .bind(point.as_of)
    .bind(granted)
    .bind(point.known_at)
    .fetch_all(tx.as_mut())
    .await?;
    let represented = crate::asof::placements::represented(tx, point).await?;
    let ids: Vec<Uuid> = rows
        .iter()
        .map(|r| r.try_get("id"))
        .collect::<Result<_, _>>()?;
    let mut insurance = insurance_views(tx, &ids, point).await?;
    let address_ids: Vec<Uuid> = rows
        .iter()
        .flat_map(|r| {
            [
                r.try_get::<Option<Uuid>, _>("address_id"),
                r.try_get::<Option<Uuid>, _>("mail_address_id"),
            ]
        })
        .filter_map(|a| a.ok().flatten())
        .collect();
    let addresses = load_addresses(tx, &address_ids).await?;
    let mut out: HashMap<Uuid, Vec<WorkplaceView>> = HashMap::new();
    for r in &rows {
        let id: Uuid = r.try_get("id")?;
        let entity: Uuid = r.try_get("legal_entity_id")?;
        let kind: Option<String> = r.try_get("biz_kind")?;
        let head: Option<Uuid> = r.try_get("head_office_workplace_id")?;
        let mode: Option<String> = r.try_get("withholding_mode")?;
        let version: Option<i32> = r.try_get("version")?;
        let not_registered_reason =
            match r.try_get::<Option<String>, _>("not_registered_reason_code")? {
                Some(code) => Some(console_entity_domain::legal_entity::CodeRef {
                    code,
                    label: r
                        .try_get::<Option<String>, _>("not_registered_reason_label")?
                        .unwrap_or_default(),
                    version: r
                        .try_get::<Option<String>, _>("not_registered_reason_version")?
                        .unwrap_or_default(),
                }),
                None => None,
            };
        let is_abstract: bool = r
            .try_get::<Option<bool>, _>("is_abstract")?
            .unwrap_or(false);
        let registration_id: Option<Uuid> = r.try_get("registration_id")?;
        let registration_todo =
            registration_id.is_none() && not_registered_reason.is_none() && !is_abstract;
        let filing_registration_id: Option<Uuid> = r.try_get("filing_registration_id")?;
        let current = match version {
            None => None,
            Some(version) => {
                let address: Option<Uuid> = r.try_get("address_id")?;
                let mail: Option<Uuid> = r.try_get("mail_address_id")?;
                let status: String = r.try_get("status")?;
                let rev_is_abstract: bool = r
                    .try_get::<Option<bool>, _>("rev_is_abstract")?
                    .unwrap_or(is_abstract);
                let rev_reason = if registration_id.is_some() {
                    None
                } else {
                    match r.try_get::<Option<String>, _>("rev_reason_code")? {
                        Some(code) => Some(console_entity_domain::legal_entity::CodeRef {
                            code,
                            label: r
                                .try_get::<Option<String>, _>("rev_reason_label")?
                                .unwrap_or_default(),
                            version: r
                                .try_get::<Option<String>, _>("rev_reason_version")?
                                .unwrap_or_default(),
                        }),
                        None => not_registered_reason.clone(),
                    }
                };
                Some(WorkplaceState {
                    version,
                    effective_from: r.try_get("effective_from")?,
                    before_first_record: r.try_get("before_first")?,
                    name: r.try_get("name")?,
                    address: address.and_then(|a| addresses.get(&a).cloned()),
                    mail_address: mail.and_then(|a| addresses.get(&a).cloned()),
                    opened_on: r.try_get("opened_on")?,
                    representative_name: if personal {
                        r.try_get("representative_name")?
                    } else {
                        None
                    },
                    main_product: r.try_get("main_product")?,
                    phone: fmt_phone(r.try_get("phone")?),
                    fax: fmt_phone(r.try_get("fax")?),
                    mobile: if personal {
                        fmt_phone(r.try_get("mobile")?)
                    } else {
                        None
                    },
                    email: if personal { r.try_get("email")? } else { None },
                    is_construction_site: r.try_get("is_construction_site")?,
                    is_abstract: rev_is_abstract,
                    not_registered_reason: rev_reason,
                    status: OperatingStatus::parse(&status).unwrap_or(OperatingStatus::Continuing),
                    status_since: r.try_get("status_since")?,
                    status_until: r.try_get("status_until")?,
                    withholding_mode: mode.as_deref().and_then(WithholdingMode::parse),
                    bulk_filed_on: r.try_get("bulk_filed_on")?,
                    independent_lsa_unit: r.try_get("independent_lsa_unit")?,
                    independent_lsa_evidence: r.try_get("independent_lsa_evidence")?,
                    change_mode: r.try_get("change_mode")?,
                })
            }
        };
        let withholding = withholding_target(WithholdingFacts {
            biz_kind: kind.as_deref().and_then(BizKind::parse),
            mode: mode.as_deref().and_then(WithholdingMode::parse),
            this_workplace: id,
            head_office_workplace: head,
            head_office_has_no_workplace: r.try_get("head_office_has_no_workplace")?,
        });
        let headcount: i64 = r.try_get("headcount")?;
        out.entry(entity).or_default().push(WorkplaceView {
            read: point.stamp(),
            id,
            legal_entity_id: entity,
            registration_id,
            sub_serial: r.try_get("sub_serial")?,
            not_registered_reason,
            is_abstract,
            registration_todo,
            filing_registration_id,
            default_branch_id: r.try_get("default_branch_id")?,
            kind_code: r.try_get("kind_code")?,
            code: r.try_get("code")?,
            is_primary: r.try_get::<Option<Uuid>, _>("primary_workplace_id")? == Some(id),
            is_head_office: head == Some(id),
            needs_confirmation: r.try_get("needs_confirmation")?,
            can_manage: false,
            closed_on: r
                .try_get::<Option<time::Date>, _>("closed_on")?
                .filter(|d| *d <= point.as_of),
            current,
            insurance: insurance.remove(&id).unwrap_or_default(),
            withholding,
            headcount,
            org_unit_id: represented.get(&id).copied(),
            regular_workers: RegularWorkers::hold(headcount),
        });
    }
    Ok(out)
}

async fn insurance_views(
    tx: &mut Tx<'_>,
    workplaces: &[Uuid],
    point: ReadPoint,
) -> Result<HashMap<Uuid, Vec<InsuranceView>>, PgEntityError> {
    let rows = sqlx::query(
        "SELECT DISTINCT ON (workplace_id, insurer) workplace_id, insurer, version, effective_from, status, mgmt_no, \
                established_on, unit_mode, main_workplace_id, effective_from > $2 AS before_first \
         FROM workplace_insurance_revisions WHERE workplace_id = ANY($1) \
           AND ($3::timestamptz IS NULL OR created_at <= $3) \
         ORDER BY workplace_id, insurer, effective_from > $2, abs(effective_from - $2), version DESC",
    )
    .bind(workplaces)
    .bind(point.as_of)
    .bind(point.known_at)
    .fetch_all(tx.as_mut())
    .await?;
    let mut out: HashMap<Uuid, Vec<InsuranceView>> = HashMap::new();
    for r in &rows {
        let insurer: String = r.try_get("insurer")?;
        let status: String = r.try_get("status")?;
        let unit: String = r.try_get("unit_mode")?;
        let (Some(insurer), Some(status), Some(unit_mode)) = (
            Insurer::parse(&insurer),
            InsuranceStatus::parse(&status),
            InsuranceUnitMode::parse(&unit),
        ) else {
            continue;
        };
        let mgmt: Option<String> = r.try_get("mgmt_no")?;
        out.entry(r.try_get("workplace_id")?)
            .or_default()
            .push(InsuranceView {
                insurer,
                version: r.try_get("version")?,
                effective_from: r.try_get("effective_from")?,
                before_first_record: r.try_get("before_first")?,
                status,
                mgmt_no: mgmt
                    .and_then(|m| InsuranceMgmtNo::parse(&m).ok())
                    .map(|m| Formatted {
                        value: m.as_str().into(),
                        display: m.display(),
                    }),
                established_on: r.try_get("established_on")?,
                unit_mode,
                main_workplace_id: r.try_get("main_workplace_id")?,
            });
    }
    Ok(out)
}
