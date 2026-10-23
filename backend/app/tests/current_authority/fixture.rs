// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

impl Fixture {
    pub(super) async fn new(owner: PgPool) -> Self {
        Self::with_home(owner, false).await
    }
    pub(super) async fn with_home(owner: PgPool, platform: bool) -> Self {
        let runtime = PgPoolOptions::new()
            .max_connections(2)
            .connect_with(
                owner
                    .connect_options()
                    .as_ref()
                    .clone()
                    .username("console_rt")
                    .password(
                        &std::env::var("CONSOLE_TEST_RUNTIME_PASSWORD")
                            .expect("disposable console_rt password must be supplied"),
                    ),
            )
            .await
            .unwrap();
        let safe: bool = sqlx::query_scalar("SELECT NOT rolsuper AND NOT rolbypassrls AND current_user = 'console_rt' FROM pg_roles WHERE rolname = current_user")
            .fetch_one(&runtime).await.unwrap();
        assert!(safe);
        let (org, user) = (OrgId::new(), UserId::new());
        sqlx::query("INSERT INTO organizations(id, slug, name) VALUES ($1, $2, 'Authority test')")
            .bind(*org.as_uuid())
            .bind(org.to_string())
            .execute(&owner)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users(id, org_id, display_name, roles, is_active) VALUES ($1, $2, 'Authority subject', ARRAY['SUPER_ADMIN'], true)")
            .bind(*user.as_uuid()).bind(*if platform { OrgId::platform() } else { org }.as_uuid()).execute(&owner).await.unwrap();
        let key = SigningKey::random(&mut OsRng);
        let private = key.to_pkcs8_pem(LineEnding::LF).unwrap();
        let public = key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        let settings = JwtSettings {
            issuer: "authority-test".into(),
            audience: "authority-test".into(),
            access_token_ttl: Duration::minutes(10),
        };
        let issuer =
            JwtIssuer::from_es256_pem(settings.clone(), private.as_bytes(), public.as_bytes())
                .unwrap();
        let verifier = JwtVerifier::from_es256_public_pem(settings, public.as_bytes()).unwrap();
        let family = console_platform_auth::RefreshTokenStore
            .issue_family(
                &runtime,
                *user.as_uuid(),
                if platform { OrgId::platform() } else { org },
                OffsetDateTime::now_utc(),
                Duration::hours(1),
            )
            .await
            .unwrap();
        console_platform_test_support::seed_session_consent(&owner, family.family_id).await;
        Self {
            family_id: family.family_id,
            private: private.to_string(),
            public,
            owner,
            runtime,
            issuer,
            verifier,
            org,
            user,
        }
    }
    pub(super) fn token(
        &self,
        org: OrgId,
        user: UserId,
        roles: &[&str],
        subject: u64,
        session: u64,
    ) -> String {
        self.issuer
            .issue_session_access_token(
                AccessTokenInput {
                    subject: user,
                    org_id: org,
                    roles: roles.iter().map(|r| (*r).to_owned()).collect(),
                    branches: vec![],
                    platform: false,
                    view_as: false,
                    read_only: false,
                    display_name: None,
                    feature_grants: vec![],
                    authz_subject_version: subject,
                    authz_policy_version: 0,
                    session_generation: session,
                    issued_at: OffsetDateTime::now_utc(),
                },
                None,
                vec![],
                self.family_id,
                OffsetDateTime::now_utc() + Duration::minutes(10),
            )
            .unwrap()
    }
    pub(super) async fn allowed(&self, token: &str) -> bool {
        resolve_principal_from_bearer_token(&self.verifier, &self.runtime, token)
            .await
            .is_ok()
    }
    pub(super) async fn versions(&self, subject: i64, session: i64) {
        sqlx::query("INSERT INTO subject_authz_versions(org_id, user_id, version, session_generation) VALUES ($1,$2,$3,$4) ON CONFLICT(org_id,user_id) DO UPDATE SET version = EXCLUDED.version, session_generation = EXCLUDED.session_generation")
            .bind(*self.org.as_uuid()).bind(*self.user.as_uuid()).bind(subject).bind(session)
            .execute(&self.owner).await.unwrap();
    }
}
