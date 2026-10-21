use console_kernel_core::{
    ActorKind, AuditAction, AuditCommandContext, AuditEvent, AuditOutcome, AuditSource, ChangeMode,
    OrgId, TraceContext, UserId,
};
use console_platform_db::{
    DbError, command_context, command_outcomes, insert_audit_event, with_audits, with_org_conn,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use time::OffsetDateTime;
use uuid::Uuid;

pub struct Fixture {
    pub owner: PgPool,
    pub rt: PgPool,
    pub org: OrgId,
    pub actor: UserId,
}
impl Fixture {
    pub async fn new(owner: PgPool) -> Self {
        sqlx::raw_sql(
            "CREATE TABLE ledger_domain_probe (
            org_id UUID NOT NULL REFERENCES organizations(id), id TEXT NOT NULL,
            PRIMARY KEY (org_id,id));
            ALTER TABLE ledger_domain_probe ENABLE ROW LEVEL SECURITY;
            ALTER TABLE ledger_domain_probe FORCE ROW LEVEL SECURITY;
            CREATE POLICY tenant ON ledger_domain_probe
              USING (org_id = NULLIF(current_setting('app.current_org',true),'')::uuid)
              WITH CHECK (org_id = NULLIF(current_setting('app.current_org',true),'')::uuid);
            GRANT SELECT,INSERT ON ledger_domain_probe TO console_rt;",
        )
        .execute(&owner)
        .await
        .unwrap();
        let rt = PgPoolOptions::new()
            .max_connections(4)
            .after_connect(|conn, _| {
                Box::pin(async move {
                    sqlx::query("SET ROLE console_rt").execute(conn).await?;
                    Ok(())
                })
            })
            .connect_with(owner.connect_options().as_ref().clone())
            .await
            .unwrap();
        Self::tenant(owner, rt).await
    }
    async fn tenant(owner: PgPool, rt: PgPool) -> Self {
        let org = OrgId::new();
        let actor = UserId::new();
        sqlx::query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,'Ledger tenant')")
            .bind(org.as_uuid())
            .bind(format!("ledger-{}", org.as_uuid().simple()))
            .execute(&owner)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users (id,org_id,display_name,roles) VALUES ($1,$2,'Ledger actor',ARRAY['SUPER_ADMIN'])")
            .bind(actor.as_uuid()).bind(org.as_uuid()).execute(&owner).await.unwrap();
        Self {
            owner,
            rt,
            org,
            actor,
        }
    }
    pub async fn another(&self) -> Self {
        Self::tenant(self.owner.clone(), self.rt.clone()).await
    }
    pub fn context(&self, id: Option<Uuid>) -> AuditCommandContext {
        let mut context = AuditCommandContext::for_actor(Some(self.actor));
        context.org_id = Some(self.org);
        context.source = AuditSource::Form;
        context.actor_kind = ActorKind::OpsAccount;
        context.change_mode = Some(ChangeMode::Governed);
        context.reason_code = Some("TYPO".into());
        context.command_id = id;
        context.scope_ids = vec![*self.org.as_uuid()];
        context
            .decision_snapshot
            .insert("approval.policy.org_structure".into(), json!(7));
        context
    }
    pub fn event(&self, id: Option<Uuid>, action: &str, target: &str, denied: bool) -> AuditEvent {
        let mut context = self.context(id);
        if denied {
            context.outcome = AuditOutcome::Denied;
        }
        AuditEvent::new(
            Some(self.actor),
            AuditAction::new(action).unwrap(),
            "ledger_probe",
            target,
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_org(self.org)
        .with_command_context(context)
        .with_snapshots(None, Some(json!({"reason_code":"TYPO"})))
    }
    pub async fn reserve(&self, key: &str, fingerprint: &[u8]) -> command_outcomes::Reservation {
        command_context::scope(
            self.context(None),
            command_outcomes::reserve(
                &self.rt,
                self.org,
                self.actor,
                key.to_owned(),
                "POST /ledger/probe".into(),
                fingerprint.to_vec(),
                json!({"masked":true}),
            ),
        )
        .await
        .unwrap()
    }
    pub async fn fresh(&self, key: &str) -> Uuid {
        match self.reserve(key, b"original").await {
            command_outcomes::Reservation::Fresh(id) => id,
            other => panic!("fresh reservation expected, got {other:?}"),
        }
    }
    pub async fn outcome(&self, id: Uuid) -> command_outcomes::CommandOutcome {
        command_outcomes::lookup(&self.rt, self.org, self.actor, id.to_string())
            .await
            .unwrap()
            .unwrap()
    }
    pub async fn apply(&self, id: Uuid, target: &str) -> Result<(), DbError> {
        let org = self.org;
        let event = self.event(Some(id), "ledger.apply", target, false);
        let target = target.to_owned();
        command_context::scope(
            self.context(Some(id)),
            with_audits(&self.rt, org, move |tx| {
                Box::pin(async move {
                    write(tx, org, &target).await?;
                    command_outcomes::set_result(tx, &json!({"id":target})).await?;
                    Ok(((), vec![event]))
                })
            }),
        )
        .await
    }
    pub async fn domain_count(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM ledger_domain_probe WHERE org_id=$1")
            .bind(self.org.as_uuid())
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }
    pub async fn audit_count(&self, id: Uuid, action: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND command_id=$2 AND action=$3",
        )
        .bind(self.org.as_uuid())
        .bind(id)
        .bind(action)
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }
    pub async fn deny(&self, id: Uuid, code: &str) {
        let event = self.event(Some(id), "command.refused", "no-write", true);
        command_outcomes::settle_refused(
            &self.rt,
            self.org,
            id,
            "REFUSED".into(),
            code.into(),
            event,
        )
        .await
        .unwrap();
    }
    pub async fn masked_audit(&self, id: Uuid) -> Value {
        let row = sqlx::query(
            "SELECT source,actor_kind,outcome,row_hash_version,decision_snapshot FROM audit_events
            WHERE org_id=$1 AND command_id=$2 AND action='command.refused'",
        )
        .bind(self.org.as_uuid())
        .bind(id)
        .fetch_one(&self.owner)
        .await
        .unwrap();
        json!({"source":row.get::<String,_>("source"),"actor_kind":row.get::<String,_>("actor_kind"),
            "outcome":row.get::<String,_>("outcome"),"version":row.get::<i16,_>("row_hash_version"),
            "decision_snapshot":row.get::<Value,_>("decision_snapshot")})
    }
}
pub async fn write(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    target: &str,
) -> Result<(), DbError> {
    sqlx::query("INSERT INTO ledger_domain_probe (org_id,id) VALUES ($1,$2)")
        .bind(org.as_uuid())
        .bind(target)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}
pub async fn denied_statement(f: &Fixture, sql: &str, id: Uuid) -> DbError {
    let sql = sql.to_owned();
    with_org_conn(&f.rt, f.org, move |tx| {
        Box::pin(async move {
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(id)
                .execute(tx.as_mut())
                .await?;
            Ok(())
        })
    })
    .await
    .unwrap_err()
}

use super::MIGRATOR;

#[sqlx::test(migrator = "MIGRATOR")]
async fn audit_v2_schema_preserves_append_only_and_rejects_invalid_source(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT column_name FROM information_schema.columns
        WHERE table_name='audit_events'",
    )
    .fetch_all(&f.owner)
    .await
    .unwrap();
    for field in [
        "source",
        "change_mode",
        "reason_code",
        "decision_snapshot",
        "command_id",
        "scope_ids",
        "actor_kind",
        "row_hash_version",
        "principal_type",
        "session_id",
        "outcome",
        "actor_display",
        "actor_employer",
    ] {
        assert!(
            names.iter().any(|name| name == field),
            "missing audit context column: {field}"
        );
    }
    let event = f.event(None, "ledger.schema", "schema", false);
    let event_id = *event.id.as_uuid();
    with_org_conn::<_, _, DbError>(&f.rt, f.org, move |tx| {
        Box::pin(async move { insert_audit_event(tx, &event).await })
    })
    .await
    .unwrap();
    let encoded: (String, String, i16) =
        sqlx::query_as("SELECT source,actor_kind,row_hash_version FROM audit_events WHERE id=$1")
            .bind(event_id)
            .fetch_one(&f.owner)
            .await
            .unwrap();
    assert_eq!(encoded, ("FORM".into(), "OPS_ACCOUNT".into(), 2));
    for sql in [
        "UPDATE audit_events SET source='API' WHERE id=$1",
        "DELETE FROM audit_events WHERE id=$1",
    ] {
        let error = sqlx::query(sql)
            .bind(event_id)
            .execute(&f.owner)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("append-only"), "{error}");
    }
    let error = sqlx::query("TRUNCATE audit_events CASCADE")
        .execute(&f.owner)
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("TRUNCATE is forbidden"),
        "{error}"
    );
    let error=sqlx::query("INSERT INTO audit_events (actor,action,target_type,target_id,trace_id,span_id,occurred_at,org_id,source)
        VALUES ($1,'ledger.bad_source','ledger_probe','bad',repeat('a',32),repeat('b',16),now(),$2,'UNTRUSTED')")
        .bind(f.actor.as_uuid()).bind(f.org.as_uuid()).execute(&f.owner).await.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1")
        .bind(f.org.as_uuid())
        .fetch_one(&f.owner)
        .await
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(f.domain_count().await, 0);
}
