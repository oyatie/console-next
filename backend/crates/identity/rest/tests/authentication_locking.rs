//! The real passkey-management router and bound handoff HTTP transactions.
//! Runtime pools enforce RLS; soft passkeys sign actual challenges. No browser claim.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{
    AccessTokenInput, JwtIssuer, JwtSettings, PasskeyRegistrationStart, PasskeyService,
    WebauthnSettings,
};
use console_platform_auth_rest::{
    AuthRestConfig, AuthRestState, DEVICE_LOGIN_APPROVE_PATH, DEVICE_LOGIN_APPROVE_SESSION_PATH,
    DEVICE_LOGIN_POLL_PATH, DEVICE_LOGIN_START_PATH, PASSKEY_ENROLL_HANDOFF_PATH,
};
use p256::{
    ecdsa::SigningKey,
    elliptic_curve::rand_core::OsRng,
    pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding},
};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction, postgres::PgPoolOptions};
use time::{Duration, OffsetDateTime};
use tokio::time::{sleep, timeout};
use tower::ServiceExt;
use uuid::Uuid;
use webauthn_authenticator_rs::{WebauthnAuthenticator, softpasskey::SoftPasskey};
const WAIT: std::time::Duration = std::time::Duration::from_secs(8);

async fn runtime(owner: &PgPool, label: &str) -> PgPool {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(
            owner
                .connect_options()
                .as_ref()
                .clone()
                .application_name(label),
        )
        .await
        .unwrap();
    let identity: (String, bool, bool) = sqlx::query_as(
        "SELECT current_user::text,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(identity, ("console_rt".into(), false, false));
    pool
}
async fn user(owner: &PgPool) -> Uuid {
    sqlx::query_scalar("INSERT INTO users(display_name,org_id,roles) VALUES('Session lock test',$1,ARRAY['MEMBER']) RETURNING id")
        .bind(*OrgId::one().as_uuid()).fetch_one(owner).await.unwrap()
}
async fn account(owner: &PgPool, user: Uuid) -> (Transaction<'_, Postgres>, i32) {
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE")
        .bind(user)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let pid = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    (tx, pid)
}
async fn blocked(owner: &PgPool, label: &str, blocker: i32) -> i32 {
    timeout(WAIT,async {
        loop {
            let waiting:Option<i32>=sqlx::query_scalar("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))")
                .bind(label).bind(blocker).fetch_optional(owner).await.unwrap();
            if let Some(pid) = waiting {break pid;}
            sleep(std::time::Duration::from_millis(5)).await;
        }
    }).await.expect("actual owner must wait for the specified blocker")
}

struct Keys {
    private: String,
    public: String,
}
impl Keys {
    fn new() -> Self {
        let key = SigningKey::random(&mut OsRng);
        Self {
            private: key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
            public: key
                .verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .unwrap(),
        }
    }
    fn settings() -> JwtSettings {
        JwtSettings {
            issuer: "console-platform-auth".into(),
            audience: "console-api".into(),
            access_token_ttl: Duration::minutes(15),
        }
    }
    fn app(&self, pool: PgPool) -> Router {
        console_platform_auth_rest::router(
            AuthRestState::new(
                pool,
                AuthRestConfig {
                    rp_id: "example.com".into(),
                    rp_origin: "https://auth.example.com".into(),
                    rp_name: "Console".into(),
                    ceremony_ttl: Duration::minutes(5),
                    jwt_issuer: "console-platform-auth".into(),
                    jwt_audience: "console-api".into(),
                    access_token_ttl: Duration::minutes(15),
                    jwt_private_key_pem: self.private.clone(),
                    jwt_public_key_pem: self.public.clone(),
                    refresh_token_ttl: Duration::days(1),
                    refresh_family_absolute_ttl: Duration::days(1),
                    cookie_secure: false,
                },
            )
            .unwrap(),
        )
    }
    async fn token(&self, rt: &PgPool, user: Uuid) -> String {
        let issuer = JwtIssuer::from_es256_pem(
            Self::settings(),
            self.private.as_bytes(),
            self.public.as_bytes(),
        )
        .unwrap();
        console_platform_test_support::issue_session_token(
            rt,
            &issuer,
            AccessTokenInput {
                subject: UserId::from_uuid(user),
                org_id: OrgId::one(),
                roles: vec!["MEMBER".into()],
                branches: vec![],
                platform: false,
                support: None,
                read_only: false,
                display_name: None,
                feature_grants: vec![],
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
}
async fn request(
    app: Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    let req = if let Some(body) = body {
        req.header("Content-Type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    } else {
        req.body(Body::empty()).unwrap()
    };
    let response = timeout(WAIT, app.oneshot(req))
        .await
        .expect("request must finish, including with one pool connection")
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let body: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    if method == "DELETE" && !status.is_success() {
        eprintln!(
            "{method} {path}: {status}, code={:?}, message={:?}",
            body.get("code"),
            body.get("message")
        );
    }
    (status, body)
}
fn service() -> PasskeyService {
    PasskeyService::new(WebauthnSettings {
        rp_id: "example.com".into(),
        rp_origin: url::Url::parse("https://auth.example.com").unwrap(),
        rp_name: "Console".into(),
        extra_allowed_origins: vec![],
        ceremony_ttl: Duration::minutes(5),
    })
    .unwrap()
}
async fn passkey(owner: &PgPool, user: Uuid) -> (Uuid, String, WebauthnAuthenticator<SoftPasskey>) {
    let svc = service();
    let start = svc
        .start_registration(
            owner,
            OrgId::one(),
            PasskeyRegistrationStart {
                user_id: user,
                username: "Lock test".into(),
                display_name: "Lock test".into(),
            },
        )
        .await
        .unwrap();
    let mut client = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let cred = client
        .do_registration(
            url::Url::parse("https://auth.example.com").unwrap(),
            soft_passkey_challenge(start.challenge),
        )
        .unwrap();
    let stored = svc
        .finish_registration(owner, OrgId::one(), start.ceremony_id, cred)
        .await
        .unwrap();
    let id = sqlx::query_scalar("SELECT id FROM auth_webauthn_credentials WHERE credential_id=$1")
        .bind(&stored.credential_id)
        .fetch_one(owner)
        .await
        .unwrap();
    (id, stored.credential_id, client)
}
async fn assertion(
    owner: &PgPool,
    id: &str,
    client: &mut WebauthnAuthenticator<SoftPasskey>,
) -> Value {
    let start = service().start_authentication(owner).await.unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] = json!([{"type":"public-key","id":id}]);
    let signed = client
        .do_authentication(
            url::Url::parse("https://auth.example.com").unwrap(),
            serde_json::from_value(challenge).unwrap(),
        )
        .unwrap();
    json!({"ceremony_id":start.ceremony_id,"credential":signed})
}
fn delete_path(id: Uuid) -> String {
    format!("/api/v1/auth/passkeys/{id}")
}
/// Two concurrent removals of a user's two passkeys, each with a fresh step-up
/// assertion: they serialize on the Account, the first wins and the second
/// keeps the last key (409).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn passkey_delete_serializes_before_keys_and_preserves_last_key(owner: PgPool) {
    let u = user(&owner).await;
    add_branch_membership(&owner, u).await;
    let keys = Keys::new();
    let rt1 = runtime(&owner, "delete-one").await;
    let rt2 = runtime(&owner, "delete-two").await;
    let token = keys.token(&rt1, u).await;
    let (key1, cred1, mut client1) = passkey(&owner, u).await;
    let (key2, cred2, mut client2) = passkey(&owner, u).await;
    let proof1 = assertion(&owner, &cred1, &mut client1).await;
    let proof2 = assertion(&owner, &cred2, &mut client2).await;
    let app1 = keys.app(rt1);
    let app2 = keys.app(rt2);
    let (held, pid) = account(&owner, u).await;
    let token1 = token.clone();
    let t1 = tokio::spawn(async move {
        request(
            app1,
            "DELETE",
            &delete_path(key1),
            Some(&token1),
            Some(json!({ "step_up": proof1 })),
        )
        .await
    });
    let first_pid = blocked(&owner, "delete-one", pid).await;
    let t2 = tokio::spawn(async move {
        request(
            app2,
            "DELETE",
            &delete_path(key2),
            Some(&token),
            Some(json!({ "step_up": proof2 })),
        )
        .await
    });
    blocked(&owner, "delete-two", first_pid).await;
    let mut probe = owner.begin().await.unwrap();
    sqlx::query("SELECT id FROM auth_webauthn_credentials WHERE id=$1 FOR UPDATE NOWAIT")
        .bind(key2)
        .fetch_one(&mut *probe)
        .await
        .unwrap();
    probe.rollback().await.unwrap();
    held.rollback().await.unwrap();
    let mut outcomes = [t1.await.unwrap().0, t2.await.unwrap().0];
    outcomes.sort();
    assert_eq!(outcomes, [StatusCode::NO_CONTENT, StatusCode::CONFLICT]);
    let state:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM auth_webauthn_credentials WHERE user_id=$1),(SELECT count(*) FROM audit_events WHERE actor=$1 AND action='auth.passkey.revoke')").bind(u).fetch_one(&owner).await.unwrap();
    assert_eq!(state, (1, 1));
    let removed: Vec<Uuid> = sqlx::query_scalar(
        "SELECT credential_row_id FROM auth_security.credential_removals WHERE account_id=$1",
    )
    .bind(u)
    .fetch_all(&owner)
    .await
    .unwrap();
    assert_eq!(removed.len(), 1);
    assert!(removed[0] == key1 || removed[0] == key2);
}
/// Deactivation while a removal waits on the Account is honoured after the
/// wait: nothing is removed.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn passkey_delete_rechecks_active_account_after_wait(owner: PgPool) {
    let u = user(&owner).await;
    add_branch_membership(&owner, u).await;
    let keys = Keys::new();
    let rt = runtime(&owner, "delete-inactive").await;
    let token = keys.token(&rt, u).await;
    let (key, cred, mut client) = passkey(&owner, u).await;
    passkey(&owner, u).await;
    let proof = assertion(&owner, &cred, &mut client).await;
    let app = keys.app(rt);
    let (mut held, pid) = account(&owner, u).await;
    let task = tokio::spawn(async move {
        request(
            app,
            "DELETE",
            &delete_path(key),
            Some(&token),
            Some(json!({ "step_up": proof })),
        )
        .await
    });
    blocked(&owner, "delete-inactive", pid).await;
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(u)
        .execute(&mut *held)
        .await
        .unwrap();
    held.commit().await.unwrap();
    assert_eq!(task.await.unwrap().0, StatusCode::UNAUTHORIZED);
    let state:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM auth_webauthn_credentials WHERE user_id=$1),(SELECT count(*) FROM audit_events WHERE actor=$1 AND action='auth.passkey.revoke')").bind(u).fetch_one(&owner).await.unwrap();
    assert_eq!(state, (2, 0));
}
async fn start_handoff(owner: &PgPool, app: Router) -> (Uuid, Value, String) {
    let (status, result) = request(app, "POST", DEVICE_LOGIN_START_PATH, None, None).await;
    assert_eq!(status, StatusCode::OK);
    let url = url::Url::parse(result["approve_url"].as_str().unwrap()).unwrap();
    let approve = url::form_urlencoded::parse(url.fragment().unwrap().as_bytes())
        .find(|(key, _)| key == "desktop_approve")
        .unwrap()
        .1
        .into_owned();
    let id = sqlx::query_scalar(
        "SELECT id FROM auth_device_login_handoffs ORDER BY created_at DESC LIMIT 1",
    )
    .fetch_one(owner)
    .await
    .unwrap();
    (id, result, approve)
}
async fn assert_account_locked(owner: &PgPool, u: Uuid) {
    let mut probe = owner.begin().await.unwrap();
    let err = sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE NOWAIT")
        .bind(u)
        .fetch_one(&mut *probe)
        .await
        .unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("55P03")
    );
    probe.rollback().await.unwrap();
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn proof_and_session_handoff_approval_hold_account_before_handoff_row(owner: PgPool) {
    for session in [false, true] {
        let u = user(&owner).await;
        let keys = Keys::new();
        let rt = runtime(&owner, "handoff-approve").await;
        let token = keys.token(&rt, u).await;
        let (_, key, mut client) = passkey(&owner, u).await;
        let app = keys.app(rt);
        let (id, _, approve) = start_handoff(&owner, app.clone()).await;
        // Bind the standard handoff's target for the session alias; no approval is fabricated.
        sqlx::query(
            "UPDATE auth_device_login_handoffs SET target_user_id=$2,target_org_id=$3 WHERE id=$1",
        )
        .bind(id)
        .bind(u)
        .bind(*OrgId::one().as_uuid())
        .execute(&owner)
        .await
        .unwrap();
        let mut body = if session {
            json!({})
        } else {
            assertion(&owner, &key, &mut client).await
        };
        body["approve_token"] = json!(approve);
        let mut held = owner.begin().await.unwrap();
        sqlx::query("SELECT id FROM auth_device_login_handoffs WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *held)
            .await
            .unwrap();
        let pid = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *held)
            .await
            .unwrap();
        let path = if session {
            DEVICE_LOGIN_APPROVE_SESSION_PATH
        } else {
            DEVICE_LOGIN_APPROVE_PATH
        };
        let task =
            tokio::spawn(async move { request(app, "POST", path, Some(&token), Some(body)).await });
        blocked(&owner, "handoff-approve", pid).await;
        assert_account_locked(&owner, u).await;
        held.rollback().await.unwrap();
        assert_eq!(task.await.unwrap().0, StatusCode::NO_CONTENT);
        let approved: Option<Uuid> = sqlx::query_scalar(
            "SELECT approved_user_id FROM auth_device_login_handoffs WHERE id=$1",
        )
        .bind(id)
        .fetch_one(&owner)
        .await
        .unwrap();
        assert_eq!(approved, Some(u));
    }
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn session_handoff_rechecks_revoked_family_after_account_wait(owner: PgPool) {
    let u = user(&owner).await;
    let keys = Keys::new();
    let rt = runtime(&owner, "approval-revoked").await;
    let token = keys.token(&rt, u).await;
    passkey(&owner, u).await;
    let app = keys.app(rt);
    let (id, _, approve) = start_handoff(&owner, app.clone()).await;
    sqlx::query(
        "UPDATE auth_device_login_handoffs SET target_user_id=$2,target_org_id=$3 WHERE id=$1",
    )
    .bind(id)
    .bind(u)
    .bind(*OrgId::one().as_uuid())
    .execute(&owner)
    .await
    .unwrap();

    let (mut held, pid) = account(&owner, u).await;
    let task = tokio::spawn(async move {
        request(
            app,
            "POST",
            DEVICE_LOGIN_APPROVE_SESSION_PATH,
            Some(&token),
            Some(json!({"approve_token": approve})),
        )
        .await
    });
    blocked(&owner, "approval-revoked", pid).await;
    sqlx::query(
        "UPDATE auth_refresh_token_families SET revoked_at=clock_timestamp(),revoked_reason='logout' WHERE user_id=$1 AND revoked_at IS NULL",
    )
    .bind(u)
    .execute(&mut *held)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE auth_refresh_tokens SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL",
    )
    .bind(u)
    .execute(&mut *held)
    .await
    .unwrap();
    held.commit().await.unwrap();

    let (status, response) = task.await.unwrap();
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{response}");
    let state: (bool, i64) = sqlx::query_as(
        "SELECT (SELECT approved_at IS NULL AND consumed_at IS NULL FROM auth_device_login_handoffs WHERE id=$1), \
         (SELECT count(*) FROM audit_events WHERE actor=$2 AND action='auth.device_login.approve_session')",
    )
    .bind(id)
    .bind(u)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(state, (true, 0));
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bound_enrollment_creation_holds_account_through_insert(owner: PgPool) {
    let u = user(&owner).await;
    let keys = Keys::new();
    let rt = runtime(&owner, "handoff-enroll").await;
    let token = keys.token(&rt, u).await;
    let (_, key, mut client) = passkey(&owner, u).await;
    let proof = assertion(&owner, &key, &mut client).await;
    let app = keys.app(rt);
    let mut held = owner.begin().await.unwrap();
    sqlx::query("LOCK TABLE auth_device_login_handoffs IN SHARE MODE")
        .execute(&mut *held)
        .await
        .unwrap();
    let pid = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *held)
        .await
        .unwrap();
    let task = tokio::spawn(async move {
        request(
            app,
            "POST",
            PASSKEY_ENROLL_HANDOFF_PATH,
            Some(&token),
            Some(json!({"step_up":proof})),
        )
        .await
    });
    blocked(&owner, "handoff-enroll", pid).await;
    assert_account_locked(&owner, u).await;
    held.rollback().await.unwrap();
    assert_eq!(task.await.unwrap().0, StatusCode::OK);
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM auth_device_login_handoffs WHERE target_user_id=$1 AND approved_at IS NULL").bind(u).fetch_one(&owner).await.unwrap();
    assert_eq!(count, 1);
}
async fn approved_handoff(owner: &PgPool, app: Router, u: Uuid) -> (Uuid, Value) {
    let (_, key, mut client) = passkey(owner, u).await;
    let (id, result, approve) = start_handoff(owner, app.clone()).await;
    let mut proof = assertion(owner, &key, &mut client).await;
    proof["approve_token"] = json!(approve);
    assert_eq!(
        request(app, "POST", DEVICE_LOGIN_APPROVE_PATH, None, Some(proof))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    (id, result)
}
async fn poll_wait(owner: &PgPool, change: u8) {
    let u = user(owner).await;
    let b = user(owner).await;
    let keys = Keys::new();
    let rt = runtime(owner, "handoff-poll").await;
    let app = keys.app(rt);
    let (id, handoff) = approved_handoff(owner, app.clone(), u).await;
    if change == 1 {
        sqlx::query("UPDATE auth_device_login_handoffs SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1").bind(id).execute(owner).await.unwrap();
    }
    let (mut held, pid) = account(owner, u).await;
    let task = tokio::spawn(async move {
        request(
            app,
            "POST",
            DEVICE_LOGIN_POLL_PATH,
            None,
            Some(json!({"poll_token":handoff["poll_token"]})),
        )
        .await
    });
    blocked(owner, "handoff-poll", pid).await;
    let mut probe = owner.begin().await.unwrap();
    sqlx::query("SELECT id FROM auth_device_login_handoffs WHERE id=$1 FOR UPDATE NOWAIT")
        .bind(id)
        .fetch_one(&mut *probe)
        .await
        .unwrap();
    probe.rollback().await.unwrap();
    if change == 1 {
        timeout(WAIT,async{loop{let expired:bool=sqlx::query_scalar("SELECT clock_timestamp()>=expires_at FROM auth_device_login_handoffs WHERE id=$1").bind(id).fetch_one(owner).await.unwrap();if expired{break;}sleep(std::time::Duration::from_millis(5)).await;}}).await.unwrap();
    } else if change == 2 {
        sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
            .bind(u)
            .execute(&mut *held)
            .await
            .unwrap();
    } else if change == 3 {
        sqlx::query("UPDATE auth_device_login_handoffs SET approved_user_id=$2 WHERE id=$1")
            .bind(id)
            .bind(b)
            .execute(owner)
            .await
            .unwrap();
    }
    held.commit().await.unwrap();
    let (status, result) = task.await.unwrap();
    if change == 0 {
        assert_eq!(status, StatusCode::OK);
        assert_eq!(result["status"], "approved");
    } else if change == 1 {
        assert!(
            status == StatusCode::UNAUTHORIZED
                || (status == StatusCode::OK && result["status"] == "expired")
        );
    } else {
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let state:(bool,i64,i64)=sqlx::query_as("SELECT (SELECT consumed_at IS NOT NULL FROM auth_device_login_handoffs WHERE id=$1),(SELECT count(*) FROM auth_refresh_token_families WHERE user_id=ANY($2)),(SELECT count(*) FROM audit_events WHERE actor=ANY($2) AND action='auth.device_login.consume')").bind(id).bind(vec![u,b]).fetch_one(owner).await.unwrap();
    assert_eq!(
        state,
        if change == 0 {
            (true, 1, 1)
        } else {
            (false, 0, 0)
        }
    );
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approved_handoff_poll_waits_before_consumption_and_issues_once(owner: PgPool) {
    poll_wait(&owner, 0).await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approved_handoff_poll_expired_during_wait_does_not_consume(owner: PgPool) {
    poll_wait(&owner, 1).await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approved_handoff_poll_inactive_during_wait_does_not_consume(owner: PgPool) {
    poll_wait(&owner, 2).await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approved_handoff_poll_changed_account_is_not_adopted(owner: PgPool) {
    poll_wait(&owner, 3).await;
}

async fn approval_after_wait(owner: &PgPool, change: u8) {
    for session in [false, true] {
        let u = user(owner).await;
        let other = user(owner).await;
        let keys = Keys::new();
        let rt = runtime(owner, "handoff-approval-state").await;
        let token = keys.token(&rt, u).await;
        let (_, key, mut client) = passkey(owner, u).await;
        let app = keys.app(rt);
        let (id, _, approve) = start_handoff(owner, app.clone()).await;
        sqlx::query(
            "UPDATE auth_device_login_handoffs SET target_user_id=$2,target_org_id=$3 WHERE id=$1",
        )
        .bind(id)
        .bind(u)
        .bind(*OrgId::one().as_uuid())
        .execute(owner)
        .await
        .unwrap();
        if change == 1 {
            sqlx::query("UPDATE auth_device_login_handoffs SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1").bind(id).execute(owner).await.unwrap();
        }
        let mut body = if session {
            json!({})
        } else {
            assertion(owner, &key, &mut client).await
        };
        body["approve_token"] = json!(approve);
        let (mut held, pid) = account(owner, u).await;
        let path = if session {
            DEVICE_LOGIN_APPROVE_SESSION_PATH
        } else {
            DEVICE_LOGIN_APPROVE_PATH
        };
        let task =
            tokio::spawn(async move { request(app, "POST", path, Some(&token), Some(body)).await });
        blocked(owner, "handoff-approval-state", pid).await;
        let mut probe = owner.begin().await.unwrap();
        sqlx::query("SELECT id FROM auth_device_login_handoffs WHERE id=$1 FOR UPDATE NOWAIT")
            .bind(id)
            .fetch_one(&mut *probe)
            .await
            .unwrap();
        probe.rollback().await.unwrap();
        if change == 1 {
            timeout(WAIT,async{loop{let expired:bool=sqlx::query_scalar("SELECT clock_timestamp()>=expires_at FROM auth_device_login_handoffs WHERE id=$1").bind(id).fetch_one(owner).await.unwrap();if expired{break;}sleep(std::time::Duration::from_millis(5)).await;}}).await.unwrap();
        } else if change == 2 {
            sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
                .bind(u)
                .execute(&mut *held)
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE auth_device_login_handoffs SET target_user_id=$2 WHERE id=$1")
                .bind(id)
                .bind(other)
                .execute(owner)
                .await
                .unwrap();
        }
        held.commit().await.unwrap();
        assert_eq!(task.await.unwrap().0, StatusCode::UNAUTHORIZED);
        let state:(bool,i64)=sqlx::query_as("SELECT (SELECT approved_at IS NULL AND consumed_at IS NULL FROM auth_device_login_handoffs WHERE id=$1),(SELECT count(*) FROM audit_events WHERE actor=$2 AND action IN ('auth.device_login.approve','auth.device_login.approve_session'))").bind(id).bind(u).fetch_one(owner).await.unwrap();
        assert_eq!(state, (true, 0));
    }
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn both_handoff_approval_paths_recheck_expiry_after_account_wait(owner: PgPool) {
    approval_after_wait(&owner, 1).await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn both_handoff_approval_paths_deny_deactivation_during_wait(owner: PgPool) {
    approval_after_wait(&owner, 2).await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn both_handoff_approval_paths_deny_changed_target_during_wait(owner: PgPool) {
    approval_after_wait(&owner, 3).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approval_and_poll_recheck_expiry_after_last_handoff_row_wait(owner: PgPool) {
    for mode in 0..3 {
        let u = user(&owner).await;
        let keys = Keys::new();
        let rt = runtime(&owner, "handoff-last-wait").await;
        let token = keys.token(&rt, u).await;
        let (_, key, mut client) = passkey(&owner, u).await;
        let app = keys.app(rt);
        let (id, handoff, approve) = start_handoff(&owner, app.clone()).await;
        sqlx::query(
            "UPDATE auth_device_login_handoffs SET target_user_id=$2,target_org_id=$3 WHERE id=$1",
        )
        .bind(id)
        .bind(u)
        .bind(*OrgId::one().as_uuid())
        .execute(&owner)
        .await
        .unwrap();
        let mut body = if mode == 1 {
            json!({})
        } else {
            assertion(&owner, &key, &mut client).await
        };
        body["approve_token"] = json!(approve);
        if mode == 2 {
            assert_eq!(
                request(
                    app.clone(),
                    "POST",
                    DEVICE_LOGIN_APPROVE_PATH,
                    None,
                    Some(body)
                )
                .await
                .0,
                StatusCode::NO_CONTENT
            );
            body = json!({"poll_token":handoff["poll_token"]});
        }
        sqlx::query("UPDATE auth_device_login_handoffs SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1").bind(id).execute(&owner).await.unwrap();
        let mut held = owner.begin().await.unwrap();
        sqlx::query("SELECT id FROM auth_device_login_handoffs WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *held)
            .await
            .unwrap();
        let pid = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *held)
            .await
            .unwrap();
        let path = match mode {
            0 => DEVICE_LOGIN_APPROVE_PATH,
            1 => DEVICE_LOGIN_APPROVE_SESSION_PATH,
            _ => DEVICE_LOGIN_POLL_PATH,
        };
        let task =
            tokio::spawn(async move { request(app, "POST", path, Some(&token), Some(body)).await });
        blocked(&owner, "handoff-last-wait", pid).await;
        timeout(WAIT,async{loop{let expired:bool=sqlx::query_scalar("SELECT clock_timestamp()>=expires_at FROM auth_device_login_handoffs WHERE id=$1").bind(id).fetch_one(&owner).await.unwrap();if expired{break;}sleep(std::time::Duration::from_millis(5)).await;}}).await.unwrap();
        held.rollback().await.unwrap();
        let (status, result) = task.await.unwrap();
        assert!(
            status == StatusCode::UNAUTHORIZED
                || (mode == 2 && status == StatusCode::OK && result["status"] == "expired")
        );
        let state:(bool,bool,i64,i64)=sqlx::query_as("SELECT (SELECT approved_at IS NOT NULL FROM auth_device_login_handoffs WHERE id=$1),(SELECT consumed_at IS NOT NULL FROM auth_device_login_handoffs WHERE id=$1),(SELECT count(*) FROM auth_refresh_token_families WHERE user_id=$2),(SELECT count(*) FROM audit_events WHERE actor=$2 AND action IN ('auth.device_login.approve','auth.device_login.approve_session','auth.device_login.consume'))").bind(id).bind(u).fetch_one(&owner).await.unwrap();
        assert_eq!(state, (mode == 2, false, 1, if mode == 2 { 1 } else { 0 }));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn session_handoff_does_not_adopt_target_changed_to_caller(owner: PgPool) {
    let caller = user(&owner).await;
    let other = user(&owner).await;
    let keys = Keys::new();
    let rt = runtime(&owner, "handoff-inverse-target").await;
    let token = keys.token(&rt, caller).await;
    passkey(&owner, caller).await;
    let app = keys.app(rt);
    let (id, _, approve) = start_handoff(&owner, app.clone()).await;
    sqlx::query(
        "UPDATE auth_device_login_handoffs SET target_user_id=$2,target_org_id=$3 WHERE id=$1",
    )
    .bind(id)
    .bind(other)
    .bind(*OrgId::one().as_uuid())
    .execute(&owner)
    .await
    .unwrap();
    let (held, pid) = account(&owner, caller).await;
    let mut task = tokio::spawn(async move {
        request(
            app,
            "POST",
            DEVICE_LOGIN_APPROVE_SESSION_PATH,
            Some(&token),
            Some(json!({"approve_token":approve})),
        )
        .await
    });
    let (status, expected_target) = tokio::select! {
        response = &mut task => {
            held.rollback().await.unwrap();
            (response.unwrap().0, other)
        }
        _ = blocked(&owner, "handoff-inverse-target", pid) => {
            sqlx::query("UPDATE auth_device_login_handoffs SET target_user_id=$2 WHERE id=$1")
                .bind(id).bind(caller).execute(&owner).await.unwrap();
            held.rollback().await.unwrap();
            (timeout(WAIT, task).await.unwrap().unwrap().0, caller)
        }
    };
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let target: Uuid =
        sqlx::query_scalar("SELECT target_user_id FROM auth_device_login_handoffs WHERE id=$1")
            .bind(id)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(target, expected_target);
    let state: (bool, i64) = sqlx::query_as("SELECT (SELECT approved_at IS NULL AND consumed_at IS NULL FROM auth_device_login_handoffs WHERE id=$1),(SELECT count(*) FROM audit_events WHERE actor=$2 AND action='auth.device_login.approve_session')")
        .bind(id).bind(caller).fetch_one(&owner).await.unwrap();
    assert_eq!(state, (true, 0));
}

// The identity alias retains its existing branch-capability gate. Supply actual
// membership so these concurrency probes reach the owner without elevating roles.
async fn add_branch_membership(owner: &PgPool, user: Uuid) {
    let org = *OrgId::one().as_uuid();
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions(name,org_id) VALUES($1,$2) RETURNING id")
            .bind(format!("Lock region {}", Uuid::new_v4()))
            .bind(org)
            .fetch_one(owner)
            .await
            .unwrap();
    let branch: Uuid = sqlx::query_scalar(
        "INSERT INTO branches(region_id,name,org_id) VALUES($1,$2,$3) RETURNING id",
    )
    .bind(region)
    .bind(format!("Lock branch {}", Uuid::new_v4()))
    .bind(org)
    .fetch_one(owner)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_branches(user_id,branch_id,org_id) VALUES($1,$2,$3)")
        .bind(user)
        .bind(branch)
        .bind(org)
        .execute(owner)
        .await
        .unwrap();
}

/// SoftPasskey has no resident-key store and rejects `requireResidentKey:
/// true`; the server now demands a discoverable credential. Relax only the
/// authenticator-facing hint (finish ignores it) so the soft token can attest.
fn soft_passkey_challenge(
    mut challenge: webauthn_authenticator_rs::prelude::CreationChallengeResponse,
) -> webauthn_authenticator_rs::prelude::CreationChallengeResponse {
    if let Some(selection) = challenge.public_key.authenticator_selection.as_mut() {
        selection.require_resident_key = false;
    }
    challenge
}
