//! Access-grant fixtures for the D0.2 tests over the 권한 screen's grants:
//! a one-line tenant role granted as the screen writes it, aged and noticed.

use std::collections::BTreeMap;

use console_identity_adapter_postgres::second_person::SecondPersonQuery;
use console_platform_authz::Feature;
use sqlx::PgPool;
use uuid::Uuid;

use super::{MIN_GRANT_AGE_DAYS, org, query};

/// How a test grant looks.
#[derive(Clone, Copy)]
pub struct Grant {
    pub domain: &'static str,
    pub level: &'static str,
    /// `None`: 회사 전체; `Some(le)`: that 법인.
    pub entity: Option<Uuid>,
    pub age_days: i32,
    pub notified: bool,
}

pub const CLOSE: Grant = Grant {
    domain: "exceptions",
    level: "edit",
    entity: None,
    age_days: 400,
    notified: true,
};

pub fn close() -> SecondPersonQuery {
    SecondPersonQuery {
        feature: Feature::PeriodLockManage,
        ..query(Uuid::nil(), &[])
    }
}

/// `grantor` grants `account` a one-line role over the scope, as the 권한
/// screen writes it; then the ledger and the role are aged and the notice
/// recorded as the holder's own confirmation.
pub async fn grant(owner: &PgPool, org: Uuid, grantor: Uuid, account: Uuid, g: Grant) -> Uuid {
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_actor', $1, true)")
        .bind(grantor.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let role: Uuid = sqlx::query_scalar(
        "INSERT INTO access_roles (org_id, name_ko, status, version, created_by, updated_at) \
         VALUES ($1, gen_random_uuid()::text, 'ACTIVE', 1, $2, now() - make_interval(days => $3)) RETURNING id",
    )
    .bind(org)
    .bind(grantor)
    .bind(g.age_days)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_role_versions (org_id, role_id, version, name_ko, status, change_mode, created_by) \
         VALUES ($1, $2, 1, 'r', 'ACTIVE', 'OPERATING', $3)",
    )
    .bind(org)
    .bind(role)
    .bind(grantor)
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO access_role_lines (org_id, role_id, version, domain, levels) VALUES ($1, $2, 1, $3, ARRAY[$4])",
    )
    .bind(org)
    .bind(role)
    .bind(g.domain)
    .bind(g.level)
    .execute(tx.as_mut())
    .await
    .unwrap();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO access_grants (org_id, account_id, role_id, scope_kind, legal_entity_id, valid_from, \
         change_mode, reason_code, granted_by) \
         VALUES ($1, $2, $3, CASE WHEN $4::uuid IS NULL THEN 'TENANT' ELSE 'LEGAL_ENTITY' END, $4, \
                 now() - make_interval(days => $5), 'OPERATING', 'NEW_HIRE', $6) RETURNING id",
    )
    .bind(org)
    .bind(account)
    .bind(role)
    .bind(g.entity)
    .bind(g.age_days)
    .bind(grantor)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE authz_grant_ledger SET occurred_at = now() - make_interval(days => $3) \
         WHERE org_id = $1 AND grant_kind = 'ACCESS_GRANT' AND grant_ref = $2",
    )
    .bind(org)
    .bind(id.to_string())
    .bind(g.age_days)
    .execute(tx.as_mut())
    .await
    .unwrap();
    if g.notified {
        sqlx::query(
            "INSERT INTO authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, event, actor_id, source, channel) \
             VALUES ($1, $2, 'ACCESS_GRANT', $3, 'NOTICE_DELIVERED', $2, 'NOTIFIER', 'IN_APP')",
        )
        .bind(org)
        .bind(account)
        .bind(id.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    id
}

/// 운영 시작: before it, a grant not marked 「설정 단계부터 적용」 counts for nothing.
pub async fn go_live(owner: &PgPool, org: Uuid, by: Uuid) {
    sqlx::query(
        "UPDATE tenant_phase SET phase = 'OPERATING', go_live_at = now(), go_live_by = $2, \
         go_live_preview_digest = repeat('a', 64) WHERE org_id = $1",
    )
    .bind(org)
    .bind(by)
    .execute(owner)
    .await
    .unwrap();
}

/// Every non-null reason of an access-grant row, by grant.
pub async fn reasons(owner: &PgPool, requester: Uuid) -> BTreeMap<String, String> {
    sqlx::query_as::<_, (String, String)>(
        "SELECT grant_ref, reason FROM second_person_candidates($1, 'period_lock_manage', '{}', '{}', \
         'exceptions', 'edit', NULL, $2, '{}', now(), make_interval(days => $3), make_interval(days => 7)) \
         WHERE via = 'ACCESS_GRANT' AND reason IS NOT NULL",
    )
    .bind(org())
    .bind(requester)
    .bind(MIN_GRANT_AGE_DAYS)
    .fetch_all(owner)
    .await
    .unwrap()
    .into_iter()
    .collect()
}
