// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) async fn console_rt_pool(owner_pool: &PgPool) -> PgPool {
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set for sqlx::test");
    let db_name: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(owner_pool)
        .await
        .unwrap();
    let base = url
        .rsplit_once('/')
        .map(|(prefix, _)| prefix.to_owned())
        .unwrap_or(url);
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|connection, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect(&format!("{base}/{db_name}"))
        .await
        .unwrap()
}

pub(super) async fn seed_tenant_user(
    pool: &PgPool,
    org: OrgId,
    user: UserId,
    role: &str,
    name: &str,
) {
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, 'sae', 'SAE') \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(*org.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, is_active, org_id) \
         VALUES ($1, $2, $3, true, $4)",
    )
    .bind(*user.as_uuid())
    .bind(name)
    .bind(vec![role.to_owned()])
    .bind(*org.as_uuid())
    .execute(pool)
    .await
    .unwrap();
}

pub(super) fn app_state(pool: PgPool, public_key_pem: String) -> AppState {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", TEST_ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", TEST_AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", public_key_pem),
    ])
    .unwrap();
    AppState::new(config, DatabaseDependency::Postgres(pool)).unwrap()
}

pub(super) async fn issue_token(
    pool: &sqlx::PgPool,
    private_pem: &[u8],
    public_pem: &[u8],
    user_id: UserId,
    org: OrgId,
    roles: Vec<String>,
) -> String {
    console_platform_test_support::issue_session_token(
        pool,
        &JwtIssuer::from_es256_pem(
            JwtSettings {
                issuer: TEST_ISSUER.to_owned(),
                audience: TEST_AUDIENCE.to_owned(),
                access_token_ttl: Duration::minutes(15),
            },
            private_pem,
            public_pem,
        )
        .unwrap(),
        AccessTokenInput {
            subject: user_id,
            org_id: org,
            roles,
            branches: Vec::<BranchId>::new(),
            platform: false,
            support: None,
            read_only: false,
            display_name: None,
            feature_grants: Vec::new(),
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: OffsetDateTime::now_utc(),
        },
        None,
        Vec::new(),
    )
    .await
}
