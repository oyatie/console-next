use axum::{
    Router,
    body::{Body, to_bytes},
    extract::Request,
    middleware::{Next, from_fn},
    response::{IntoResponse, Response},
    routing::post,
};
use console_kernel_core::{
    ActorKind, AuditAction, AuditCommandContext, AuditEvent, AuditRequestContext, BranchScope,
    OrgId, TraceContext,
};
use console_platform_authz::{Principal, Role};
use console_platform_db::{DbError, command_outcomes, with_audit};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::Notify;
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Clone)]
pub struct Fixture {
    pub owner: PgPool,
    pub rt: PgPool,
    pub principal: Principal,
    pub entered: Arc<Notify>,
    pub release: Arc<Notify>,
}
impl Fixture {
    pub async fn new(owner: PgPool) -> Self {
        sqlx::raw_sql("CREATE TABLE ledger_http_probe (org_id UUID NOT NULL, id UUID PRIMARY KEY, payload JSONB NOT NULL);
            ALTER TABLE ledger_http_probe ENABLE ROW LEVEL SECURITY;
            ALTER TABLE ledger_http_probe FORCE ROW LEVEL SECURITY;
            CREATE POLICY tenant ON ledger_http_probe
              USING (org_id = NULLIF(current_setting('app.current_org',true),'')::uuid)
              WITH CHECK (org_id = NULLIF(current_setting('app.current_org',true),'')::uuid);
            GRANT SELECT,INSERT ON ledger_http_probe TO console_rt;")
            .execute(&owner).await.unwrap();
        let org = OrgId::new();
        let actor = seed_org_and_super_admin(&owner, *org.as_uuid(), "ledger-http").await;
        let principal = Principal::new(
            actor,
            org,
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        )
        .with_tenant_ops(true);
        Self {
            rt: runtime_role_pool(&owner).await,
            owner,
            principal,
            entered: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        }
    }
    pub fn without_read(&self) -> Self {
        let mut f = self.clone();
        f.principal.roles = BTreeSet::from([Role::Member]);
        f.principal.is_tenant_ops = false;
        f.principal.effective_feature_grants.clear();
        f
    }
    pub fn router(&self) -> Router {
        let route = self.clone();
        let boundary = self.clone();
        Router::new()
            .route(
                "/probe",
                post(move |axum::Json(body): axum::Json<Value>| {
                    let f = route.clone();
                    async move { apply(f, body).await }
                }),
            )
            .layer(from_fn(move |request: Request, next: Next| {
                let f = boundary.clone();
                async move {
                    let transport = super::super::RequestAuditContext {
                        trace: TraceContext::generate(),
                        request: AuditRequestContext::default(),
                        session_id: Some(Uuid::new_v4()),
                    };
                    crate::CURRENT_ORG
                        .scope(
                            f.principal.org_id,
                            crate::CURRENT_AUDIT_CONTEXT.scope(
                                transport.clone(),
                                super::run(&f.rt, &f.principal, transport, request, next),
                            ),
                        )
                        .await
                }
            }))
    }
    pub async fn send(&self, key: &str, body: Value) -> Response {
        self.router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/probe")
                    .header("content-type", "application/json")
                    .header("idempotency-key", key)
                    .header("sec-fetch-mode", "cors")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    pub async fn writes(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM ledger_http_probe WHERE org_id=$1")
            .bind(self.principal.org_id.as_uuid())
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }
    pub async fn outcome(&self, key: &str) -> command_outcomes::CommandOutcome {
        command_outcomes::lookup(
            &self.rt,
            self.principal.org_id,
            self.principal.user_id,
            key.into(),
        )
        .await
        .unwrap()
        .unwrap()
    }
    pub async fn refused(
        &self,
        response: Response,
        status: StatusCode,
        code: &str,
        writes: i64,
        denials: i64,
    ) -> Value {
        assert_eq!(response.status(), status);
        let body = body(response).await;
        assert_eq!(body["error"]["code"], code);
        assert_eq!(
            self.writes().await,
            writes,
            "refusal must not write business data"
        );
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events
            WHERE org_id=$1 AND action='command.refused' AND outcome='DENIED'
              AND after_snap->>'refusal_code'=$2",
        )
        .bind(self.principal.org_id.as_uuid())
        .bind(code)
        .fetch_one(&self.owner)
        .await
        .unwrap();
        assert_eq!(
            count, denials,
            "every refusal must have negative audit evidence"
        );
        let snapshot: Value = sqlx::query_scalar(
            "SELECT after_snap FROM audit_events
            WHERE org_id=$1 AND action='command.refused' AND after_snap->>'refusal_code'=$2
            ORDER BY created_at DESC,id DESC LIMIT 1",
        )
        .bind(self.principal.org_id.as_uuid())
        .bind(code)
        .fetch_one(&self.owner)
        .await
        .unwrap();
        assert_eq!(snapshot, json!({"refusal_code":code}));
        body
    }
    pub async fn history(&self, action: &str, name: &str, before: Value, after: Value) -> Uuid {
        let mut context = AuditCommandContext::for_actor(Some(self.principal.user_id));
        context.actor_kind = ActorKind::OpsAccount;
        context.actor_display = Some(name.into());
        let event = self
            .event(action)
            .with_command_context(context)
            .with_snapshots(Some(before), Some(after));
        let id = *event.id.as_uuid();
        with_audit::<_, _, DbError>(&self.rt, event, |_| Box::pin(async { Ok(()) }))
            .await
            .unwrap();
        id
    }
    fn event(&self, action: &str) -> AuditEvent {
        AuditEvent::new(
            Some(self.principal.user_id),
            AuditAction::new(action).unwrap(),
            "user",
            self.principal.user_id.to_string(),
            TraceContext::generate(),
            time::OffsetDateTime::now_utc(),
        )
        .with_org(self.principal.org_id)
    }
}
pub async fn body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}
async fn apply(f: Fixture, body: Value) -> Response {
    let mode = body.get("mode").and_then(Value::as_str).unwrap_or("ok");
    if mode == "preview" {
        return axum::Json(json!({"preview": true})).into_response();
    }
    if mode == "hold" {
        f.entered.notify_one();
        f.release.notified().await;
    }
    let fail = matches!(mode, "refuse" | "stale");
    let set_result = mode != "no_result";
    let result = json!({"id":f.principal.user_id,"value":body["value"]});
    let safe = result.clone();
    let payload = body.clone();
    let org = f.principal.org_id;
    let wrote = with_audit::<_, _, DbError>(&f.rt, f.event("user.update"), move |tx| {
        Box::pin(async move {
            sqlx::query("INSERT INTO ledger_http_probe (org_id,id,payload) VALUES ($1,$2,$3)")
                .bind(org.as_uuid())
                .bind(Uuid::new_v4())
                .bind(payload)
                .execute(tx.as_mut())
                .await?;
            if fail {
                return Err(DbError::Sqlx(sqlx::Error::Protocol(
                    "fixture refusal".into(),
                )));
            }
            if set_result {
                command_outcomes::set_result(tx, &safe).await?;
            }
            Ok(())
        })
    })
    .await;
    match wrote {
        Ok(()) if mode == "no_result" => (StatusCode::CREATED, "committed").into_response(),
        Ok(()) => (StatusCode::CREATED, axum::Json(result)).into_response(),
        Err(DbError::Sqlx(sqlx::Error::Protocol(message))) if message == "fixture refusal" => {
            let (status, code) = if mode == "stale" {
                (StatusCode::CONFLICT, "stale_revision")
            } else {
                (StatusCode::UNPROCESSABLE_ENTITY, "validation")
            };
            super::refusal(status, code, None)
        }
        Err(error) => panic!("unexpected fixture mutation failure: {error}"),
    }
}
