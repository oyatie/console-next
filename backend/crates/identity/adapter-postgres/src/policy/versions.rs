use crate::PgOrgError;
use sqlx::{Postgres, Row, Transaction};

pub(crate) async fn bump_policy_version_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    occurred_at: time::OffsetDateTime,
) -> Result<(), PgOrgError> {
    sqlx::query(
        r#"
        INSERT INTO policy_versions (org_id, version, updated_at)
        VALUES ($1, 1, $2)
        ON CONFLICT (org_id) DO UPDATE
        SET version = policy_versions.version + 1,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(org_uuid)
    .bind(occurred_at)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// Bump a subject's authorization `version` (+1) inside the caller's audited,
/// org-armed transaction. Called from authorization-relevant subject mutations
/// (system-role and custom-role assignment writes) so a later Cedar slice can
/// detect a token minted before the change and deny the stale subject. The first
/// bump upserts the (org,user) row at version 1; every later bump increments it.
///
/// SLICE-2: this only SOURCES freshness. No authorization decision consults it
/// yet, so bumping here changes no live outcome.
pub(crate) async fn bump_subject_version_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    user_uuid: uuid::Uuid,
    occurred_at: time::OffsetDateTime,
) -> Result<(), PgOrgError> {
    sqlx::query(
        r#"
        INSERT INTO subject_authz_versions (org_id, user_id, version, session_generation, updated_at)
        VALUES ($1, $2, 1, 1, $3)
        ON CONFLICT (org_id, user_id) DO UPDATE
        SET version = subject_authz_versions.version + 1,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(org_uuid)
    .bind(user_uuid)
    .bind(occurred_at)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// Bump a subject's `session_generation` (+1) inside the caller's audited,
/// org-armed transaction. Called from credential/session events that must
/// invalidate previously minted sessions (e.g. offboarding credential + session
/// revocation). Mirrors [`bump_subject_version_tx`]; the first bump upserts the
/// row at session_generation 1.
pub(crate) async fn bump_subject_session_generation_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
    user_uuid: uuid::Uuid,
    occurred_at: time::OffsetDateTime,
) -> Result<(), PgOrgError> {
    sqlx::query(
        r#"
        INSERT INTO subject_authz_versions (org_id, user_id, version, session_generation, updated_at)
        VALUES ($1, $2, 1, 1, $3)
        ON CONFLICT (org_id, user_id) DO UPDATE
        SET session_generation = subject_authz_versions.session_generation + 1,
            updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(org_uuid)
    .bind(user_uuid)
    .bind(occurred_at)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// Read a subject's current `(version, session_generation)` under RLS. An absent
/// row means "no bump yet" and reads as `(0, 0)`, matching the mint-time default
/// (`get_policy_version`'s version-0 convention) so a token predating any bump
/// carries the safe baseline.
pub(crate) async fn fetch_subject_authz_versions_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_uuid: uuid::Uuid,
) -> Result<(i64, i64), PgOrgError> {
    let row = sqlx::query(
        r#"
        SELECT version, session_generation
        FROM subject_authz_versions
        WHERE user_id = $1
        "#,
    )
    .bind(user_uuid)
    .fetch_optional(tx.as_mut())
    .await?;
    match row {
        Some(row) => Ok((row.try_get("version")?, row.try_get("session_generation")?)),
        None => Ok((0, 0)),
    }
}

pub(crate) async fn lock_policy_version_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: uuid::Uuid,
) -> Result<i64, PgOrgError> {
    let version = sqlx::query_scalar(
        r#"
        SELECT version
        FROM policy_versions
        WHERE org_id = $1
        FOR UPDATE
        "#,
    )
    .bind(org_uuid)
    .fetch_optional(tx.as_mut())
    .await?
    .unwrap_or(0);
    Ok(version)
}
