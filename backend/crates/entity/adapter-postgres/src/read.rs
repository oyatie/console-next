//! Read model: entity → registrations → workplaces, as of today (KST).
//!
//! "Current" is the revision with the latest `effective_from` on or before
//! today (ties: highest version); later-dated revisions are "scheduled".
//! Before the first revision takes effect, that first revision is current,
//! flagged `before_first_record` (INTEG-3).

use std::collections::HashMap;

use console_entity_application::{
    LegalEntityState, LegalEntityView, ReadOptions, ReadPoint, RegularWorkers,
};
use console_entity_domain::codes::{
    BizKind, CloseReason, RepresentationMode, VatUnitBasis, VatUnitMode,
};
use console_entity_domain::legal_entity::CodeRef;
use sqlx::Row;
use sqlx::postgres::PgRow;
use uuid::Uuid;

use crate::address::load_addresses;
pub(crate) use crate::format::{fmt_brn, fmt_crn, fmt_phone};
use crate::{PgEntityError, Tx, today_kst};

pub(crate) fn code_ref(r: &PgRow, prefix: &str) -> Result<Option<CodeRef>, sqlx::Error> {
    let code: Option<String> = r.try_get(format!("{prefix}_code").as_str())?;
    let label: Option<String> = r.try_get(format!("{prefix}_label").as_str())?;
    let version: Option<String> = r.try_get(format!("{prefix}_version").as_str())?;
    Ok(code
        .zip(label)
        .zip(version)
        .map(|((code, label), version)| CodeRef {
            code,
            label,
            version,
        }))
}

/// Every non-voided entity (or one), with registrations and workplaces.
pub(crate) async fn entities(
    tx: &mut Tx<'_>,
    only: Option<Uuid>,
    granted: Option<&[Uuid]>,
    personal: bool,
) -> Result<Vec<LegalEntityView>, PgEntityError> {
    let point = ReadPoint::new(today_kst(tx).await?, ReadOptions::default());
    entities_at(tx, only, granted, personal, point).await
}

pub(crate) async fn entities_at(
    tx: &mut Tx<'_>,
    only: Option<Uuid>,
    granted: Option<&[Uuid]>,
    personal: bool,
    point: ReadPoint,
) -> Result<Vec<LegalEntityView>, PgEntityError> {
    let heads = sqlx::query(
        "SELECT id, biz_kind, crn, founding, needs_confirmation, identity_locked_at IS NOT NULL AS locked, closed_on, close_reason_code, \
                primary_workplace_id, head_office_workplace_id, head_office_has_no_workplace \
         FROM (SELECT (jsonb_populate_record(NULL::legal_entities, entity_known_row(to_jsonb(b), $3))).* FROM legal_entities b) h WHERE (voided_at IS NULL OR voided_at > $3) \
           AND ($3::timestamptz IS NULL OR h.created_at <= $3) AND ($1::uuid IS NULL OR id = $1) \
           AND ($2::uuid[] IS NULL OR id = ANY($2) OR EXISTS (SELECT 1 FROM workplaces w WHERE w.legal_entity_id = h.id AND w.id = ANY($2))) \
         ORDER BY sort_order NULLS LAST, created_at, id",
    )
    .bind(only)
    .bind(granted)
    .bind(point.known_at)
    .fetch_all(tx.as_mut())
    .await?;
    let ids: Vec<Uuid> = heads
        .iter()
        .map(|r| r.try_get("id"))
        .collect::<Result<_, _>>()?;
    let mut states = entity_states(tx, &ids, point, personal).await?;
    let mut registrations =
        crate::asof::registrations::registrations(tx, &ids, point, personal).await?;
    let mut workplaces =
        crate::workplace_views::views_at(tx, &ids, granted, point, personal).await?;
    let mut entities = heads
        .iter()
        .map(|r| {
            let id: Uuid = r.try_get("id")?;
            let kind: Option<String> = r.try_get("biz_kind")?;
            let (current, scheduled) = states.remove(&id).unwrap_or_default();
            let wps = workplaces.remove(&id).unwrap_or_default();
            Ok(LegalEntityView {
                read: point.stamp(),
                id,
                biz_kind: kind.as_deref().and_then(BizKind::parse),
                crn: fmt_crn(r.try_get("crn")?),
                needs_confirmation: r.try_get("needs_confirmation")?,
                identity_locked: r.try_get("locked")?,
                founding: r.try_get("founding")?,
                can_manage: false,
                closed_on: r
                    .try_get::<Option<time::Date>, _>("closed_on")?
                    .filter(|d| *d <= point.as_of),
                close_reason_code: r
                    .try_get::<Option<String>, _>("close_reason_code")?
                    .as_deref()
                    .and_then(CloseReason::parse),
                primary_workplace_id: r.try_get("primary_workplace_id")?,
                head_office_workplace_id: r.try_get("head_office_workplace_id")?,
                head_office_has_no_workplace: r.try_get("head_office_has_no_workplace")?,
                identity_problems: Vec::new(),
                name_reviews: Vec::new(),
                current,
                scheduled,
                registrations: registrations.remove(&id).unwrap_or_default(),
                regular_workers: RegularWorkers::hold(wps.iter().map(|w| w.headcount).sum()),
                workplaces: wps,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(PgEntityError::from)?;
    let mut reviews = if personal {
        crate::name_review::open(tx, &ids).await?
    } else {
        HashMap::new()
    };
    for e in &mut entities {
        e.name_reviews = reviews.remove(&e.id).unwrap_or_default();
        // 법인명/상호 has one stored source: every registration's ① is the entity's name.
        let name = e
            .current
            .as_ref()
            .map(|c| c.name.clone())
            .unwrap_or_default();
        for r in e
            .registrations
            .iter_mut()
            .filter_map(|r| r.current.as_mut())
        {
            r.trade_name.clone_from(&name);
        }
        e.identity_problems = console_entity_application::name_evidence::identity_problems(e);
    }
    crate::asof::membership::record_counts(tx, point, &mut entities).await?;
    Ok(entities)
}

type States = HashMap<Uuid, (Option<LegalEntityState>, Vec<LegalEntityState>)>;

async fn entity_states(
    tx: &mut Tx<'_>,
    ids: &[Uuid],
    point: ReadPoint,
    personal: bool,
) -> Result<States, PgEntityError> {
    let rows = sqlx::query(
        "SELECT r.*, (SELECT array_agg(p.name ORDER BY p.seq) FROM legal_entity_representatives p \
                      WHERE p.org_id = r.org_id AND p.revision_id = r.id) AS reps, \
                (SELECT array_agg(d.role ORDER BY d.seq) FROM legal_entity_directors d WHERE d.revision_id = r.id) AS director_roles, \
                (SELECT array_agg(d.name ORDER BY d.seq) FROM legal_entity_directors d WHERE d.revision_id = r.id) AS director_names, \
                (SELECT array_agg(d.appointed_on ORDER BY d.seq) FROM legal_entity_directors d WHERE d.revision_id = r.id) AS director_dates \
         FROM legal_entity_revisions r WHERE r.legal_entity_id = ANY($1) \
           AND ($2::timestamptz IS NULL OR r.created_at <= $2) \
         ORDER BY r.legal_entity_id, r.effective_from, r.version",
    )
    .bind(ids)
    .bind(point.known_at)
    .fetch_all(tx.as_mut())
    .await?;
    let address_ids: Vec<Uuid> = rows
        .iter()
        .filter_map(|r| r.try_get("head_office_address_id").ok().flatten())
        .collect();
    let addresses = load_addresses(tx, &address_ids).await?;
    let mut out: States = HashMap::new();
    for r in &rows {
        let entity: Uuid = r.try_get("legal_entity_id")?;
        let addr: Option<Uuid> = r.try_get("head_office_address_id")?;
        let mode: Option<String> = r.try_get("representation_mode")?;
        let vat: Option<String> = r.try_get("vat_unit_mode")?;
        let basis: Option<String> = r.try_get("vat_unit_mode_basis")?;
        let state = LegalEntityState {
            version: r.try_get("version")?,
            effective_from: r.try_get("effective_from")?,
            before_first_record: false,
            name: r.try_get("name")?,
            display_name: r.try_get("display_name")?,
            english_name: r.try_get("english_name")?,
            representation_mode: mode.as_deref().and_then(RepresentationMode::parse),
            representatives: if personal {
                Some(
                    r.try_get::<Option<Vec<String>>, _>("reps")?
                        .unwrap_or_default(),
                )
            } else {
                None
            },
            additional_representatives: r.try_get("additional_representatives")?,
            head_office_address: addr.and_then(|a| addresses.get(&a).cloned()),
            incorporated_on: r.try_get("incorporated_on")?,
            fiscal_year_end_month: r.try_get("fiscal_year_end_month")?,
            capital_won: r.try_get("capital_won")?,
            directors: if personal {
                Some(crate::format::directors(r)?)
            } else {
                None
            },
            vat_unit_mode: vat.as_deref().and_then(VatUnitMode::parse),
            vat_unit_mode_basis: basis.as_deref().and_then(VatUnitBasis::parse),
            main_ksic: code_ref(r, "main_ksic")?,
            main_phone: fmt_phone(r.try_get("main_phone")?),
            priority_support: r.try_get("priority_support")?,
            priority_support_basis: r.try_get("priority_support_basis")?,
            large_group_member: r.try_get("large_group_member")?,
            change_mode: r.try_get("change_mode")?,
        };
        let slot = out.entry(entity).or_default();
        if state.effective_from <= point.as_of {
            slot.0 = Some(state); // rows are ordered: the last one on or before today wins
        } else {
            slot.1.push(state);
        }
    }
    for slot in out.values_mut() {
        if slot.0.is_none() && !slot.1.is_empty() {
            let mut first = slot.1.remove(0);
            first.before_first_record = true;
            slot.0 = Some(first);
        }
    }
    Ok(out)
}
