// SPDX-License-Identifier: LicenseRef-Proprietary
//! Storage and lock helpers for platform second-operator management.

use crate::{
    BootstrapToken, PlatformOperatorStatus, PlatformOperatorSummary, ProvisioningError,
    count_user_passkeys_tx, generate_platform_invite_token, hash_platform_invite_token,
};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::lock_account_tx;
use sqlx::{Postgres, Row, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

pub(super) async fn arm_platform_actor(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
) -> Result<(), ProvisioningError> {
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(OrgId::platform().as_uuid().to_string())
        .execute(tx.as_mut())
        .await?;
    sqlx::query("SELECT set_config('app.current_actor', $1, true)")
        .bind(actor.as_uuid().to_string())
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

pub(super) async fn lock_platform_accounts_ordered(
    tx: &mut Transaction<'_, Postgres>,
    first: Uuid,
    second: Uuid,
) -> Result<(Option<bool>, Option<bool>), ProvisioningError> {
    let platform = OrgId::platform();
    if first == second {
        let active = lock_account_tx(tx, platform, first).await?;
        Ok((active, active))
    } else if first < second {
        let a = lock_account_tx(tx, platform, first).await?;
        let b = lock_account_tx(tx, platform, second).await?;
        Ok((a, b))
    } else {
        let b = lock_account_tx(tx, platform, second).await?;
        let a = lock_account_tx(tx, platform, first).await?;
        Ok((a, b))
    }
}

pub(super) async fn actor_authority_facts(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
) -> Result<Option<(bool, bool, Vec<String>, bool)>, ProvisioningError> {
    let row: Option<(bool, bool, Vec<String>)> = sqlx::query_as(
        "SELECT org_id = $1, is_active, roles FROM users WHERE org_id = $1 AND id = $2",
    )
    .bind(OrgId::platform().as_uuid())
    .bind(actor.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;
    let Some((is_platform, is_active, roles)) = row else {
        return Ok(None);
    };
    let has_passkey = count_user_passkeys_tx(tx, *actor.as_uuid()).await? > 0;
    Ok(Some((is_platform, is_active, roles, has_passkey)))
}

pub(super) async fn verify_operator_step_up(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    assertion: Uuid,
    object_id: Uuid,
    payload_hash: &str,
) -> Result<bool, ProvisioningError> {
    let proof: bool = sqlx::query_scalar(
        "SELECT EXISTS(\
            SELECT 1 FROM step_up_assertions s \
            JOIN auth_webauthn_credentials c ON c.id = s.credential_row_id AND c.user_id = s.user_id \
            WHERE s.ceremony_id = $1 AND s.user_id = $2 AND s.org_id = $3 \
              AND s.action_kind = 'OPERATOR_RECOVERY' AND s.object_id = $4 \
              AND s.payload_hash = $5 AND s.user_verified\
        )",
    )
    .bind(assertion)
    .bind(actor.as_uuid())
    .bind(OrgId::platform().as_uuid())
    .bind(object_id)
    .bind(payload_hash)
    .fetch_one(tx.as_mut())
    .await?;
    if !proof {
        return Err(ProvisioningError::PlatformOperator("unauthorized"));
    }
    Ok(proof)
}

pub(super) async fn other_active_enrolled_count_tx(
    tx: &mut Transaction<'_, Postgres>,
    excluded_user_id: Uuid,
) -> Result<i64, ProvisioningError> {
    Ok(sqlx::query_scalar(
        "SELECT count(*) \
         FROM person_accounts_current u \
         WHERE u.org_id = $1 \
           AND u.id <> $2 \
           AND u.is_active \
           AND 'SUPER_ADMIN' = ANY(u.roles) \
           AND EXISTS (SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id = u.id)",
    )
    .bind(OrgId::platform().as_uuid())
    .bind(excluded_user_id)
    .fetch_one(tx.as_mut())
    .await?)
}

pub(super) async fn fetch_operator_summaries(
    tx: &mut Transaction<'_, Postgres>,
    target_user_id: Option<Uuid>,
    now: OffsetDateTime,
) -> Result<Vec<PlatformOperatorSummary>, ProvisioningError> {
    let rows = sqlx::query(
        r#"
        SELECT
            u.id AS user_id,
            u.display_name,
            (
                SELECT s.login || '@' || o.slug
                FROM user_sign_in_ids s
                JOIN organizations o ON o.id = s.org_id
                WHERE s.org_id = u.org_id AND s.user_id = u.id AND s.retired_at IS NULL
                LIMIT 1
            ) AS sign_in_id,
            u.is_active,
            EXISTS(SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id = u.id) AS has_passkey,
            EXISTS(
                SELECT 1 FROM auth_webauthn_credentials c
                WHERE c.user_id = u.id
                  AND c.passkey_json#>>'{cred,backup_eligible}' = 'false'
            ) AS device_bound_passkey,
            inv.invited_by,
            inv.expires_at AS invite_expires_at,
            inv.revoked_at AS invite_revoked_at,
            u.created_at
        FROM person_accounts_current u
        LEFT JOIN LATERAL (
            SELECT i.invited_by, i.expires_at, i.revoked_at
            FROM platform_operator_invites i
            WHERE i.org_id = u.org_id AND i.user_id = u.id
            ORDER BY i.issued_at DESC, i.id DESC
            LIMIT 1
        ) inv ON true
        WHERE u.org_id = $1
          AND 'SUPER_ADMIN' = ANY(u.roles)
          AND ($2::uuid IS NULL OR u.id = $2)
        ORDER BY u.created_at ASC, u.id ASC
        "#,
    )
    .bind(OrgId::platform().as_uuid())
    .bind(target_user_id)
    .fetch_all(tx.as_mut())
    .await?;

    rows.into_iter()
        .map(|row| {
            let is_active: bool = row.try_get("is_active")?;
            let has_passkey: bool = row.try_get("has_passkey")?;
            let invite_expires_at: Option<OffsetDateTime> = row.try_get("invite_expires_at")?;
            let invite_revoked_at: Option<OffsetDateTime> = row.try_get("invite_revoked_at")?;
            let status = if !is_active {
                PlatformOperatorStatus::Revoked
            } else if has_passkey {
                PlatformOperatorStatus::Active
            } else if invite_expires_at.is_some_and(|exp| exp <= now) && invite_revoked_at.is_none()
            {
                PlatformOperatorStatus::Expired
            } else {
                PlatformOperatorStatus::PendingEnrolment
            };
            Ok(PlatformOperatorSummary {
                user_id: row.try_get("user_id")?,
                display_name: row.try_get("display_name")?,
                sign_in_id: row.try_get("sign_in_id")?,
                is_active,
                has_passkey,
                device_bound_passkey: row.try_get("device_bound_passkey")?,
                status,
                invited_by: row.try_get("invited_by")?,
                invite_expires_at,
                created_at: row.try_get("created_at")?,
            })
        })
        .collect()
}

pub(super) async fn issue_invite_credential_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    assertion: Uuid,
    user_id: Uuid,
    now: OffsetDateTime,
    ttl: Duration,
) -> Result<(Uuid, Uuid, BootstrapToken, OffsetDateTime), ProvisioningError> {
    let invite_id = Uuid::new_v4();
    let credential_id = Uuid::new_v4();
    let token = generate_platform_invite_token()?;
    let token_hash = hash_platform_invite_token(token.as_str());
    let expires_at = now + ttl;
    let platform_uuid = *OrgId::platform().as_uuid();

    sqlx::query(
        "INSERT INTO auth_bootstrap_credentials \
         (id, user_id, token_hash, issued_at, expires_at, org_id, single_use) \
         VALUES ($1, $2, $3, $4, $5, $6, true)",
    )
    .bind(credential_id)
    .bind(user_id)
    .bind(token_hash)
    .bind(now)
    .bind(expires_at)
    .bind(platform_uuid)
    .execute(tx.as_mut())
    .await?;

    sqlx::query(
        "INSERT INTO platform_operator_invites \
         (id, org_id, user_id, credential_id, invited_by, invite_assertion_id, issued_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(invite_id)
    .bind(platform_uuid)
    .bind(user_id)
    .bind(credential_id)
    .bind(actor.as_uuid())
    .bind(assertion)
    .bind(now)
    .bind(expires_at)
    .execute(tx.as_mut())
    .await?;

    Ok((invite_id, credential_id, token, expires_at))
}
