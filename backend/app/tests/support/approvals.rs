// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{grants, http, people};
use console_kernel_core::UserId;
use sqlx::PgPool;
use uuid::Uuid;

pub async fn document(pool: &PgPool, org: Uuid, maker: UserId, code: &str) -> Uuid {
    let id = sqlx::query_scalar("INSERT INTO org_change_requests (org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) VALUES ($1,$2,'REORG','IN_APPROVAL','REGION','region','조직 개편',CURRENT_DATE,'변경 검토','[]',$3,$4,repeat('a',64)) RETURNING id")
        .bind(org).bind(code).bind(maker.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO org_change_approval_steps(org_id,request_id,step_order,role_key) VALUES($1,$2,1,'hr'),($1,$2,2,'executive')")
        .bind(org).bind(id).execute(pool).await.unwrap();
    id
}
pub async fn setup(pool: &PgPool) -> (Uuid, UserId, UserId) {
    let (org, maker) = http::tenant(pool, &["SUPER_ADMIN"]).await;
    let checker = http::add_user(pool, org, &["EXECUTIVE"]).await;
    for user in [maker, checker] {
        people::bind_user_to_distinct_person(pool, user).await;
        grants::grant_org_approve(pool, user).await;
    }
    (org, maker, checker)
}

pub async fn ctx(
    pool: &PgPool,
    org: Uuid,
    user: UserId,
    roles: &[&str],
    session: Option<&'static str>,
) -> http::Ctx {
    let mut ctx = http::ctx(pool, org, user, roles, session).await;
    let keys = http::keys();
    let config = console_app::AppConfig::from_pairs([
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", keys.1.clone()),
        ("CONSOLE_JWT_ISSUER", "console-platform-auth".into()),
        ("CONSOLE_JWT_AUDIENCE", "console-api".into()),
        ("CONSOLE_RELEASE_TOGGLES", "approvals".into()),
    ])
    .unwrap();
    ctx.token = http::token(pool, &keys, org, user, roles).await;
    ctx.service = console_app::build_router(
        console_app::AppState::new(
            config,
            console_app::DatabaseDependency::Postgres(
                http::role_pool(pool, "console_rt", session).await,
            ),
        )
        .unwrap(),
    );
    ctx
}
