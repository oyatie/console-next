//! Load registration evidence; the domain owns classification decisions.
use crate::{PgEntityError, Tx};
use console_entity_domain::{Refusal, codes::BizKind};
use sqlx::Row;
use uuid::Uuid;

#[derive(Debug)]
pub struct CompanyCandidate {
    pub workplace_id: Uuid,
    pub name: String,
    pub alias: Option<String>,
    pub matching_names: Vec<String>,
    pub registration_numbers: Vec<String>,
    pub workplaces: Vec<Uuid>,
}

/// Only independently transcribed, matching certificates supply employer candidates.
pub async fn company_candidates(
    tx: &mut Tx<'_>,
    _org: Uuid,
) -> Result<Vec<CompanyCandidate>, PgEntityError> {
    let entities = crate::read::entities(tx, None, None, true).await?;
    let mut out = Vec::new();
    for e in entities {
        if e.closed_on.is_some() || e.needs_confirmation || !e.identity_problems.is_empty() {
            continue;
        }
        let Some(c) = &e.current else {
            continue;
        };
        let Some(w) = e
            .workplaces
            .iter()
            .find(|w| Some(w.id) == e.primary_workplace_id && w.closed_on.is_none())
        else {
            continue;
        };
        let certificate = e
            .registrations
            .iter()
            .find(|r| Some(r.id) == w.registration_id);
        let Some(registration) = certificate else {
            continue;
        };
        let Some(facts) = &registration.current else {
            continue;
        };
        let brn = registration.brn.as_ref().map(|b| b.value.clone());
        if classification(
            e.biz_kind,
            brn.as_deref(),
            true,
            facts.classification_reason.as_deref(),
        )
        .is_err()
        {
            continue;
        }
        out.push(CompanyCandidate {
            workplace_id: w.id,
            name: c.name.clone(),
            alias: c.display_name.clone(),
            matching_names: [Some(&c.name), c.english_name.as_ref()]
                .into_iter()
                .flatten()
                .cloned()
                .collect(),
            registration_numbers: e
                .registrations
                .iter()
                .filter(|r| !r.needs_confirmation && r.closed_on.is_none() && r.current.is_some())
                .filter_map(|r| r.brn.as_ref().map(|b| b.value.clone()))
                .collect(),
            workplaces: e
                .workplaces
                .iter()
                .filter(|w| w.closed_on.is_none())
                .map(|w| w.id)
                .collect(),
        });
    }
    Ok(out)
}

pub(crate) fn classification(
    kind: Option<BizKind>,
    brn: Option<&str>,
    primary: bool,
    reason: Option<&str>,
) -> Result<(), PgEntityError> {
    let Some(brn) = brn else {
        return Ok(());
    };
    let rule = console_entity_domain::registration_classification::classification(brn);
    console_entity_domain::registration_number::validate_classification(
        kind,
        primary,
        reason,
        rule.map(|r| (r.biz_kinds.as_slice(), r.head_office)),
    )?;
    Ok(())
}

pub(crate) async fn primary_registration(
    tx: &mut Tx<'_>,
    entity: Uuid,
    registration: Option<Uuid>,
) -> Result<(), PgEntityError> {
    let Some(registration) = registration else {
        return Ok(());
    };
    let row = sqlx::query("SELECT e.biz_kind, h.brn, r.classification_reason FROM legal_entities e JOIN business_registrations h ON h.legal_entity_id = e.id LEFT JOIN LATERAL (SELECT classification_reason FROM business_registration_revisions x WHERE x.registration_id = h.id ORDER BY x.effective_from DESC, x.version DESC LIMIT 1) r ON true WHERE e.id = $1 AND h.id = $2")
        .bind(entity).bind(registration).fetch_optional(tx.as_mut()).await?
        .ok_or_else(|| Refusal::not_found("registration_not_found"))?;
    let kind: Option<String> = row.try_get("biz_kind")?;
    let brn: Option<String> = row.try_get("brn")?;
    let reason: Option<String> = row.try_get("classification_reason")?;
    classification(
        kind.as_deref().and_then(BizKind::parse),
        brn.as_deref(),
        true,
        reason.as_deref(),
    )
}

pub(crate) async fn primary_workplace(
    tx: &mut Tx<'_>,
    entity: Uuid,
    workplace: Uuid,
) -> Result<(), PgEntityError> {
    let registration: Option<Uuid> = sqlx::query_scalar(
        "SELECT registration_id FROM workplaces WHERE id = $1 AND legal_entity_id = $2",
    )
    .bind(workplace)
    .bind(entity)
    .fetch_optional(tx.as_mut())
    .await?
    .flatten();
    primary_registration(tx, entity, registration).await
}

pub(crate) async fn revise_classification(
    tx: &mut Tx<'_>,
    entity: Uuid,
    id: Uuid,
    kind: Option<BizKind>,
    draft: &console_entity_domain::registration::RegistrationDraft,
) -> Result<(), PgEntityError> {
    let primary: bool = sqlx::query_scalar("SELECT NOT EXISTS (SELECT 1 FROM business_registrations WHERE legal_entity_id = $1 AND id <> $2 AND voided_at IS NULL AND closed_on IS NULL) OR EXISTS (SELECT 1 FROM legal_entities e JOIN workplaces w ON w.id = e.primary_workplace_id WHERE e.id = $1 AND w.registration_id = $2)").bind(entity).bind(id).fetch_one(tx.as_mut()).await?;
    let previous: Option<String> = sqlx::query_scalar("SELECT classification_reason FROM business_registration_revisions WHERE registration_id = $1 ORDER BY effective_from DESC, version DESC LIMIT 1").bind(id).fetch_optional(tx.as_mut()).await?.flatten();
    let reason = draft
        .classification_reason
        .as_ref()
        .map_or(previous.as_deref(), |r| r.as_deref());
    classification(
        kind,
        draft.brn.as_ref().map(|b| b.as_str()),
        primary,
        reason,
    )
}

/// Identifier corrections must obey the same rules as certificate entry.
pub(crate) async fn correct_classification(
    tx: &mut Tx<'_>,
    entity: Uuid,
    kind: Option<BizKind>,
    number: Option<(Uuid, &str)>,
) -> Result<(), PgEntityError> {
    let rows = sqlx::query("SELECT h.id, h.brn, r.classification_reason, count(*) OVER () = 1 OR EXISTS (SELECT 1 FROM legal_entities e JOIN workplaces w ON w.id = e.primary_workplace_id WHERE e.id = $1 AND w.registration_id = h.id) AS primary FROM business_registrations h LEFT JOIN LATERAL (SELECT classification_reason FROM business_registration_revisions x WHERE x.registration_id = h.id ORDER BY x.effective_from DESC, x.version DESC LIMIT 1) r ON true WHERE h.legal_entity_id = $1 AND h.voided_at IS NULL AND h.closed_on IS NULL")
        .bind(entity).fetch_all(tx.as_mut()).await?;
    for row in rows {
        let id: Uuid = row.try_get("id")?;
        let brn: Option<String> = row.try_get("brn")?;
        let reason: Option<String> = row.try_get("classification_reason")?;
        let brn = number
            .filter(|(changed, _)| *changed == id)
            .map(|(_, n)| n)
            .or(brn.as_deref());
        classification(kind, brn, row.try_get("primary")?, reason.as_deref())?;
    }
    Ok(())
}
