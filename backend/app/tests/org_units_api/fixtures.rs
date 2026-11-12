// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[path = "../../../test-support/org_change_fixtures.rs"]
mod org_change_fixtures;
#[path = "../../../test-support/person_fixtures.rs"]
mod person_fixtures;

pub(super) async fn seed_org(pool: &PgPool, org: Uuid, name: &str) {
    let slug = format!("ou-{}", &org.simple().to_string()[..12]);
    go_live::live_org(pool, org, slug, name).await;
}

pub(super) async fn seed_user(pool: &PgPool, org: Uuid) -> UserId {
    let user = UserId::new();
    sqlx::query("WITH u AS (INSERT INTO users (id, display_name, roles, org_id, is_active) VALUES ($1, 'Admin', $2, $3, true) RETURNING id, org_id) INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) SELECT org_id, 'approval.policy.org_structure', '\"route\"', id, 'BW01' FROM u")
        .bind(*user.as_uuid())
        .bind(["SUPER_ADMIN"].as_slice())
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    person_fixtures::bind_user_to_distinct_person(pool, user).await;
    org_change_fixtures::grant_org_approve(pool, user).await;
    console_platform_test_support::seed_passkey(pool, OrgId::from_uuid(org), user).await;
    user
}

pub(super) async fn seed_branch(pool: &PgPool, org: Uuid) -> Uuid {
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ('수도권', $1) RETURNING id")
            .bind(org)
            .fetch_one(pool)
            .await
            .unwrap();
    sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, '본점', $2) RETURNING id",
    )
    .bind(region)
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// An ACTIVE site as fixture rows (a workplace's own unit is made by the entity
/// face; decisions #18 retired bare SITE proposals).
pub(super) async fn seed_fixture_unit(pool: &PgPool, org: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
        .bind(org)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO org_unit_revisions \
         (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
         SELECT $1, $2, 1, gen_random_uuid(), u.id, decode(repeat('00', 32), 'hex'), \
                jsonb_build_object('name', $3::text, 'kind', 'site'), '{}'::jsonb \
         FROM users u WHERE u.org_id = $1 LIMIT 1",
    )
    .bind(org)
    .bind(id)
    .bind(name)
    .execute(pool)
    .await
    .unwrap();
    id
}

pub(super) fn keys() -> (String, String) {
    let key = SigningKey::generate();
    (
        key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
        key.verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
    )
}

pub(super) async fn token(
    pool: &PgPool,
    keys: &(String, String),
    org: Uuid,
    user: UserId,
) -> String {
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: ISSUER.to_owned(),
            audience: AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.0.as_bytes(),
        keys.1.as_bytes(),
    )
    .unwrap();
    console_platform_test_support::issue_session_token(
        pool,
        &issuer,
        AccessTokenInput {
            subject: user,
            org_id: OrgId::from_uuid(org),
            roles: vec!["SUPER_ADMIN".to_owned()],
            branches: Vec::new(),
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
        vec![],
    )
    .await
}

pub(super) async fn role_pool(owner: &PgPool, role: &'static str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(move |conn, _| {
            Box::pin(async move {
                let statement = match role {
                    "console_rt" => "SET ROLE console_rt",
                    _ => "SET ROLE console_leave_cmd",
                };
                sqlx::query(statement).execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(owner.connect_options().as_ref().clone())
        .await
        .unwrap()
}

pub(super) fn app_state(
    runtime: PgPool,
    leave_command: PgPool,
    public_pem: String,
) -> Result<AppState, console_app::AppError> {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", ISSUER.to_owned()),
        ("CONSOLE_JWT_AUDIENCE", AUDIENCE.to_owned()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", public_pem),
    ])?;
    AppState::new(config, DatabaseDependency::Postgres(runtime))
        .map(|state| state.with_leave_command_database(leave_command))
}
