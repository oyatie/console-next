// SPDX-License-Identifier: LicenseRef-Proprietary
//! Check evidence storage. Request values never enter this module except the public number.
use crate::{PgEntityError, Tx};
use console_entity_application::registration_check::{
    CheckAnswer, CheckEvidence, CheckFailure, UnavailableReason,
};
use console_entity_domain::Refusal;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

pub(crate) fn failure(error: CheckFailure) -> PgEntityError {
    let refusal = match error {
        CheckFailure::Unavailable(reason) => Refusal::conflict(
            "registration_check_unavailable",
            "issuing-authority check unavailable",
        )
        .with_remedy(reason_code(reason)),
        CheckFailure::RateLimited {
            retry_after_seconds,
            ..
        } => {
            let mut refusal = Refusal::conflict(
                "registration_check_rate_limited",
                "issuing-authority check rate limited",
            )
            .with_remedy("retry_later");
            refusal.retry_after_seconds = std::num::NonZeroU64::new(retry_after_seconds.max(1));
            refusal
        }
        CheckFailure::Contract { .. } => Refusal::conflict(
            "registration_check_unavailable",
            "issuing-authority response could not be verified",
        )
        .with_remedy("PROVIDER_DOWN"),
    };
    refusal.into()
}
pub(crate) const fn reason_code(reason: UnavailableReason) -> &'static str {
    match reason {
        UnavailableReason::NotConfigured => "NOT_CONFIGURED",
        UnavailableReason::KeyExpired => "KEY_EXPIRED",
        UnavailableReason::KeyRejected => "KEY_REJECTED",
        UnavailableReason::ProviderDown => "PROVIDER_DOWN",
    }
}

pub(crate) async fn audit_failure<T>(
    store: &crate::PgEntityStore,
    actor: &console_entity_application::Actor,
    target: Uuid,
    kind: console_entity_application::registration_check::CheckKind,
    result: Result<T, PgEntityError>,
) -> Result<T, PgEntityError> {
    if let Err(PgEntityError::Refused(refusal)) = &result {
        let fields: &[&str] = match kind {
            console_entity_application::registration_check::CheckKind::Status => &["brn"],
            console_entity_application::registration_check::CheckKind::Validate => {
                &["brn", "opened_on", "representative"]
            }
        };
        let event = console_kernel_core::AuditEvent::new(
            Some(actor.user),
            console_kernel_core::AuditAction::new("business_registration.check_refused").map_err(Refusal::from)?,
            "business_registration", target.to_string(), actor.trace.clone(), time::OffsetDateTime::now_utc(),
        ).with_org(actor.org).with_snapshots(None, Some(json!({"kind":kind,"purpose":"registration_evidence","fields_requested":fields,"code":refusal.code})));
        console_platform_db::with_audit(&store.pool, event, |_tx| {
            Box::pin(async { Ok::<_, PgEntityError>(()) })
        })
        .await?;
    }
    result
}

pub(crate) async fn append(
    tx: &mut Tx<'_>,
    registration: Uuid,
    actor: Option<Uuid>,
    answer: &CheckAnswer,
    checked_at: Option<time::OffsetDateTime>,
) -> Result<Uuid, PgEntityError> {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO business_registration_checks (org_id,id,registration_id,brn_checked,kind,trigger,b_stt_cd,reported_status,tax_type_cd,end_dt,utcc_yn,tax_type_change_dt,invoice_apply_dt,rbf_tax_type_cd,valid,not_registered,fields_sent,response_sha256,provider_version,actor_id,checked_at) \
        VALUES (NULLIF(current_setting('app.current_org',true),'')::uuid,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,COALESCE($20,clock_timestamp()))")
        .bind(id).bind(registration).bind(&answer.brn_checked)
        .bind(match answer.kind { console_entity_application::registration_check::CheckKind::Status => "STATUS", console_entity_application::registration_check::CheckKind::Validate => "VALIDATE" })
        .bind(if actor.is_some() { "USER" } else { "SCHEDULE" }).bind(&answer.status_code)
        .bind(answer.reported_status.map(|s| s.as_str())).bind(&answer.tax_type_cd).bind(&answer.end_dt)
        .bind(&answer.utcc_yn).bind(&answer.tax_type_change_dt).bind(&answer.invoice_apply_dt)
        .bind(&answer.rbf_tax_type_cd).bind(&answer.valid).bind(answer.not_registered).bind(&answer.fields_sent)
        .bind(&answer.response_sha256).bind(&answer.provider_version).bind(actor).bind(checked_at).execute(tx.as_mut()).await?;
    Ok(id)
}

/// Mismatches are derived from the latest current-number evidence and dated tenant fact.
pub(crate) async fn reconcile(
    tx: &mut Tx<'_>,
    registration: Uuid,
    lag_days: i64,
) -> Result<(), PgEntityError> {
    let (latest, mismatch, agreed): (Option<Uuid>, bool, bool) = sqlx::query_as(
        "SELECT c.id, COALESCE(c.reported_status IS DISTINCT FROM r.status AND c.reported_status IS NOT NULL \
              OR c.not_registered AND (now() AT TIME ZONE 'Asia/Seoul')::date > COALESCE(r.opened_on,(h.created_at AT TIME ZONE 'Asia/Seoul')::date) + $2::int, false), \
           COALESCE(c.id IS NULL OR c.reported_status=r.status OR EXISTS(SELECT 1 FROM business_registration_check_items i JOIN business_registration_checks old ON old.id=i.check_id WHERE i.registration_id=h.id AND i.closed_at IS NULL AND old.reported_status=r.status),false) \
         FROM business_registrations h LEFT JOIN LATERAL (SELECT * FROM business_registration_checks c \
           WHERE c.registration_id=h.id AND c.brn_checked=h.brn AND (c.reported_status IS NOT NULL OR c.not_registered) ORDER BY checked_at DESC,id DESC LIMIT 1) c ON true \
         LEFT JOIN LATERAL (SELECT * FROM business_registration_revisions r WHERE r.registration_id=h.id \
           ORDER BY effective_from > (now() AT TIME ZONE 'Asia/Seoul')::date, abs(effective_from-(now() AT TIME ZONE 'Asia/Seoul')::date),version DESC LIMIT 1) r ON true WHERE h.id=$1")
        .bind(registration).bind(i32::try_from(lag_days).unwrap_or(i32::MAX)).fetch_one(tx.as_mut()).await?;
    if let Some(check) = latest.filter(|_| mismatch) {
        sqlx::query("INSERT INTO business_registration_check_items(org_id,registration_id,check_id) VALUES(NULLIF(current_setting('app.current_org',true),'')::uuid,$1,$2) ON CONFLICT(org_id,registration_id) WHERE closed_at IS NULL DO UPDATE SET check_id=excluded.check_id")
            .bind(registration).bind(check).execute(tx.as_mut()).await?;
    } else if agreed {
        sqlx::query("UPDATE business_registration_check_items SET closed_at=now() WHERE registration_id=$1 AND closed_at IS NULL").bind(registration).execute(tx.as_mut()).await?;
    }
    Ok(())
}

pub(crate) async fn evidence(
    tx: &mut Tx<'_>,
    id: Uuid,
    lag_days: i64,
) -> Result<CheckEvidence, PgEntityError> {
    evidence_many(tx, &[id], lag_days)
        .await?
        .remove(&id)
        .ok_or_else(|| Refusal::not_found("registration_not_found").into())
}

pub(crate) async fn evidence_many(
    tx: &mut Tx<'_>,
    ids: &[Uuid],
    lag_days: i64,
) -> Result<std::collections::HashMap<Uuid, CheckEvidence>, PgEntityError> {
    let rows = sqlx::query("SELECT to_jsonb(c) || jsonb_build_object('status_code',c.b_stt_cd) AS answer, \
        c.brn_checked=h.brn AND COALESCE(c.reported_status IS DISTINCT FROM r.status AND c.reported_status IS NOT NULL \
           OR c.not_registered AND (now() AT TIME ZONE 'Asia/Seoul')::date > COALESCE(r.opened_on,(h.created_at AT TIME ZONE 'Asia/Seoul')::date)+$2::int,false) AS mismatch, \
        c.not_registered AND (now() AT TIME ZONE 'Asia/Seoul')::date <= COALESCE(r.opened_on,(h.created_at AT TIME ZONE 'Asia/Seoul')::date)+$2::int AS reflection_pending, \
        (SELECT i.id FROM business_registration_check_items i JOIN business_registration_checks open_check ON open_check.id=i.check_id WHERE i.registration_id=c.registration_id AND i.closed_at IS NULL AND open_check.brn_checked=h.brn AND c.brn_checked=h.brn LIMIT 1) AS inbox_item_id \
        FROM business_registration_checks c JOIN business_registrations h ON h.id=c.registration_id \
        LEFT JOIN LATERAL (SELECT * FROM business_registration_revisions r WHERE r.registration_id=h.id ORDER BY effective_from > (now() AT TIME ZONE 'Asia/Seoul')::date, abs(effective_from-(now() AT TIME ZONE 'Asia/Seoul')::date),version DESC LIMIT 1) r ON true WHERE c.id=ANY($1)")
        .bind(ids).bind(i32::try_from(lag_days).unwrap_or(i32::MAX)).fetch_all(tx.as_mut()).await?;
    let mut result = std::collections::HashMap::new();
    for row in rows {
        let mut value: serde_json::Value = row.try_get("answer")?;
        value["recorded_status_mismatch"] = json!(
            row.try_get::<bool, _>("mismatch")?
                || row.try_get::<Option<Uuid>, _>("inbox_item_id")?.is_some()
        );
        value["reflection_pending"] = json!(row.try_get::<bool, _>("reflection_pending")?);
        value["inbox_item_id"] = json!(row.try_get::<Option<Uuid>, _>("inbox_item_id")?);
        let item: CheckEvidence = serde_json::from_value(value)?;
        result.insert(item.id, item);
    }
    Ok(result)
}

pub(crate) async fn subject(
    tx: &mut Tx<'_>,
    id: Uuid,
    pack: &str,
) -> Result<(Uuid, String), PgEntityError> {
    let row = sqlx::query("SELECT legal_entity_id,brn,voided_at,check_pack FROM business_registrations WHERE id=$1 FOR UPDATE")
        .bind(id).fetch_optional(tx.as_mut()).await?.ok_or_else(|| Refusal::not_found("registration_not_found"))?;
    if row
        .try_get::<Option<time::OffsetDateTime>, _>("voided_at")?
        .is_some()
    {
        return Err(Refusal::conflict(
            "registration_check_registration_ended",
            "the registration was voided",
        )
        .into());
    }
    let brn: String = row.try_get::<Option<String>, _>("brn")?.ok_or_else(|| {
        Refusal::conflict(
            "registration_check_no_number",
            "the registration number is pending",
        )
    })?;
    if row.try_get::<String, _>("check_pack")? != pack {
        return Err(failure(CheckFailure::Unavailable(
            UnavailableReason::NotConfigured,
        )));
    }
    Ok((row.try_get("legal_entity_id")?, brn))
}
