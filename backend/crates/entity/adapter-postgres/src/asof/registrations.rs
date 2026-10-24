//! Effective-dated registration state and its printed classifications.
use crate::address::load_addresses;
use crate::read::{code_ref, fmt_brn};
use crate::{PgEntityError, Tx};
use console_entity_application::{
    BusinessTypeView, ReadPoint, RegistrationState, RegistrationView,
};
use console_entity_domain::codes::{
    BrnPendingReason, NtsTaxType, OperatingStatus, UnverifiedReason,
};
use sqlx::Row;
use std::collections::HashMap;
use uuid::Uuid;

pub(crate) async fn registrations(
    tx: &mut Tx<'_>,
    entity_ids: &[Uuid],
    point: ReadPoint,
    personal: bool,
) -> Result<HashMap<Uuid, Vec<RegistrationView>>, PgEntityError> {
    let heads = sqlx::query(
        "SELECT h.*, h.identity_locked_at IS NOT NULL AS locked, registration_verification_tier(h.id,h.brn,$3) AS derived_tier, c.id AS check_id, r.id AS rev_id, r.version, r.effective_from, \
                r.trade_name, r.classification_reason, r.opened_on, r.business_address_id, r.unit_taxation, r.tax_type, r.tax_office_code, \
                r.tax_office_label, r.issue_reason_kind, r.issue_reason_sub, r.issue_reason_as_printed, \
                r.cert_issued_on, r.e_invoice_email, r.liquor_license_no, r.production_factor, r.status, \
                r.status_since, r.status_until, r.change_mode, r.effective_from > $2 AS before_first \
         FROM (SELECT (jsonb_populate_record(NULL::business_registrations, entity_known_row(to_jsonb(b), $3))).* FROM business_registrations b) h \
         LEFT JOIN LATERAL (SELECT * FROM business_registration_revisions x WHERE x.registration_id = h.id \
                            AND ($3::timestamptz IS NULL OR x.created_at <= $3) \
                            ORDER BY x.effective_from > $2, abs(x.effective_from - $2), x.version DESC LIMIT 1) r ON true \
         LEFT JOIN LATERAL (SELECT id FROM business_registration_checks c WHERE c.registration_id=h.id AND c.brn_checked=h.brn AND ($3::timestamptz IS NULL OR c.checked_at<=$3) ORDER BY c.checked_at DESC,c.id DESC LIMIT 1) c ON true \
         WHERE h.legal_entity_id = ANY($1) AND (h.voided_at IS NULL OR h.voided_at > $3) \
           AND ($3::timestamptz IS NULL OR h.created_at <= $3) ORDER BY h.created_at, h.id",
    )
    .bind(entity_ids)
    .bind(point.as_of)
    .bind(point.known_at)
    .fetch_all(tx.as_mut())
    .await?;
    let rev_ids: Vec<Uuid> = heads
        .iter()
        .filter_map(|r| r.try_get("rev_id").ok().flatten())
        .collect();
    let types = business_types(tx, &rev_ids).await?;
    let owners: HashMap<Uuid, Vec<String>> = sqlx::query_as::<_, (Uuid, Vec<String>)>(
        "SELECT revision_id, array_agg(name ORDER BY seq) FROM business_registration_co_owners \
         WHERE revision_id = ANY($1) GROUP BY revision_id",
    )
    .bind(&rev_ids)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .collect();
    let address_ids: Vec<Uuid> = heads
        .iter()
        .filter_map(|r| r.try_get("business_address_id").ok().flatten())
        .collect();
    let addresses = load_addresses(tx, &address_ids).await?;
    let check_ids: Vec<Uuid> = heads
        .iter()
        .filter_map(|r| r.try_get("check_id").ok().flatten())
        .collect();
    let mut checks = crate::registration_check::evidence_many(
        tx,
        &check_ids,
        crate::CheckSchedulePolicy::default().reflection_lag_days,
    )
    .await?;
    let mut out: HashMap<Uuid, Vec<RegistrationView>> = HashMap::new();
    for r in &heads {
        let rev: Option<Uuid> = r.try_get("rev_id")?;
        let current = match rev {
            None => None,
            Some(rev) => {
                let addr: Option<Uuid> = r.try_get("business_address_id")?;
                let tax: Option<String> = r.try_get("tax_type")?;
                let status: String = r.try_get("status")?;
                Some(RegistrationState {
                    version: r.try_get("version")?,
                    effective_from: r.try_get("effective_from")?,
                    before_first_record: r.try_get("before_first")?,
                    // Legacy NULL falls back to the entity name in `read::entities`.
                    trade_name: r
                        .try_get::<Option<String>, _>("trade_name")?
                        .unwrap_or_default(),
                    classification_reason: if personal {
                        r.try_get("classification_reason")?
                    } else {
                        None
                    },
                    opened_on: r.try_get("opened_on")?,
                    business_address: addr.and_then(|a| addresses.get(&a).cloned()),
                    business_types: types.get(&rev).cloned().unwrap_or_default(),
                    unit_taxation: r.try_get("unit_taxation")?,
                    tax_type: tax.as_deref().and_then(NtsTaxType::parse),
                    tax_office_code: r.try_get("tax_office_code")?,
                    tax_office_label: r.try_get("tax_office_label")?,
                    issue_reason_kind: r.try_get("issue_reason_kind")?,
                    issue_reason_sub: r.try_get("issue_reason_sub")?,
                    issue_reason_as_printed: r.try_get("issue_reason_as_printed")?,
                    cert_issued_on: r.try_get("cert_issued_on")?,
                    e_invoice_email: r.try_get("e_invoice_email")?,
                    liquor_license_no: r.try_get("liquor_license_no")?,
                    production_factor: r.try_get("production_factor")?,
                    co_owners: personal.then(|| owners.get(&rev).cloned().unwrap_or_default()),
                    status: OperatingStatus::parse(&status).unwrap_or(OperatingStatus::Continuing),
                    status_since: r.try_get("status_since")?,
                    status_until: r.try_get("status_until")?,
                    change_mode: r.try_get("change_mode")?,
                })
            }
        };
        let mut nts_check = r
            .try_get::<Option<Uuid>, _>("check_id")?
            .and_then(|id| checks.remove(&id));
        if let Some(check) = &mut nts_check {
            if point.stamp().read_only {
                check.inbox_item_id = None;
                check.reflection_pending = check.answer.not_registered
                    && current.as_ref().and_then(|c| c.opened_on).is_some_and(|d| {
                        (point.as_of - d).whole_days()
                            <= crate::CheckSchedulePolicy::default().reflection_lag_days
                    });
            }
            check.recorded_status_mismatch = check
                .answer
                .reported_status
                .zip(current.as_ref().map(|c| c.status))
                .is_some_and(|(a, b)| a != b)
                || check.answer.not_registered && !check.reflection_pending
                || check.inbox_item_id.is_some();
        }
        let tier: String = r.try_get("derived_tier")?;
        let number: Option<String> = r.try_get("brn")?;
        let unverified_reason = if tier != "NONE" || nts_check.is_some() {
            None
        } else if number.is_none() {
            Some(UnverifiedReason::NewRegistrationPending)
        } else {
            Some(UnverifiedReason::NotChecked)
        };
        let entity: Uuid = r.try_get("legal_entity_id")?;
        out.entry(entity).or_default().push(RegistrationView {
            id: r.try_get("id")?,
            legal_entity_id: entity,
            brn: fmt_brn(r.try_get("brn")?),
            brn_pending_reason: r
                .try_get::<Option<String>, _>("brn_pending_reason")?
                .as_deref()
                .and_then(BrnPendingReason::parse),
            holder_workplace_id: r.try_get("holder_workplace_id")?,
            verification_tier: tier,
            voided: r
                .try_get::<Option<time::OffsetDateTime>, _>("voided_at")?
                .is_some(),
            nts_check,
            unverified_reason,
            needs_confirmation: r.try_get("needs_confirmation")?,
            identity_locked: r.try_get("locked")?,
            closed_on: r
                .try_get::<Option<time::Date>, _>("closed_on")?
                .filter(|d| *d <= point.as_of),
            current,
        });
    }
    Ok(out)
}

async fn business_types(
    tx: &mut Tx<'_>,
    rev_ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<BusinessTypeView>>, PgEntityError> {
    let rows = sqlx::query(
        "SELECT * FROM business_registration_business_types WHERE revision_id = ANY($1) ORDER BY revision_id, seq",
    )
    .bind(rev_ids)
    .fetch_all(tx.as_mut())
    .await?;
    let mut out: HashMap<Uuid, Vec<BusinessTypeView>> = HashMap::new();
    for r in &rows {
        out.entry(r.try_get("revision_id")?)
            .or_default()
            .push(BusinessTypeView {
                is_main: r.try_get("is_main")?,
                sector_as_printed: r.try_get("sector_as_printed")?,
                item_as_printed: r.try_get("item_as_printed")?,
                nts_code: r.try_get("nts_code")?,
                ksic: code_ref(r, "ksic")?,
            });
    }
    Ok(out)
}
