#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! E-S3b through the `HrService` entry points, on a `console_rt` pool: leave
//! and transfers recorded in SETUP are setup records (decisions #26); a TRANSFER moves the employee between
//! 사업장 of one 법인 (전근), by name or with the unit it moves them to, now or
//! on its date; rescinding it moves them back; a move to another 법인 is a
//! 전적 and never a TRANSFER. A GROUP_TRANSFER (전적) moves them to another
//! 법인 with the consent and the continuity choice, until rescinded.

mod cross_entity;
mod filing_review;
mod group;
mod initial_placement;
mod placement_tree;
mod previous_writer;
mod settlement;
mod trail_scope;
mod transfer;

use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::authz::APPOINTMENT_KEYS;
use console_hr_adapter_postgres::lifecycle::requests::CreateEmployeeLifecycleEventRequest;
use console_hr_adapter_postgres::lifecycle::void::RescindLifecycleEventRequest;
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::access::{NodeKind, ScopeGrant};
use console_platform_authz::{Principal, Role};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Date, Duration, OffsetDateTime, UtcOffset};
use uuid::Uuid;

struct Fixture {
    hr: HrService,
    owner: PgPool,
    principal: Principal,
    org: Uuid,
    user: Uuid,
    employee: Uuid,
}

/// Today in KST, the date the lifecycle rules use.
fn today() -> Date {
    OffsetDateTime::now_utc()
        .to_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
        .date()
}

fn day(offset: i64) -> String {
    (today() + Duration::days(offset)).to_string()
}

/// A tenant (opened in SETUP by the organizations trigger, then moved to
/// OPERATING unless `live` is false), its HR admin and one employee.
async fn fixture(pool: PgPool, live: bool) -> Fixture {
    let (org, user) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'E-S3b test org')")
        .bind(org)
        .bind(format!("es3b-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'HR 담당', $2, $3)",
    )
    .bind(user)
    .bind(["SUPER_ADMIN"])
    .bind(org)
    .execute(&pool)
    .await
    .unwrap();
    if live {
        // rls-arming: ok test fixture moves the tenant past 운영 시작 as owner
        let sql = format!("UPDATE tenant_phase SET phase = 'OPERATING' WHERE org_id = '{org}'");
        seed(&pool, org, sql).await;
    }
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, position, source_filename, source_sheet, \
         source_row, source_key, hire_date) \
         VALUES ($1, 'Co', '정하늘', '사원', 'console', 'console', 1, $2, '2026-01-02') RETURNING id",
    )
    .bind(org)
    .bind(Uuid::new_v4().to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    let options = pool.connect_options().as_ref().clone();
    let rt = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt")
                    .execute(conn)
                    .await
                    .map(|_| ())
            })
        })
        .connect_with(options)
        .await
        .unwrap();
    let principal = Principal::new(
        UserId::from_uuid(user),
        OrgId::from_uuid(org),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    Fixture {
        hr: HrService::new(rt),
        owner: pool,
        principal,
        org,
        user,
        employee,
    }
}

/// Fixture rows written as the owner, in the tenant, with triggers and FKs off.
async fn seed(pool: &PgPool, org: Uuid, sql: String) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

impl Fixture {
    /// A 법인 with `n` open 사업장: `(entity, workplaces)`.
    async fn entity(&self, n: usize) -> (Uuid, Vec<Uuid>) {
        let (org, entity) = (self.org, Uuid::new_v4());
        let workplaces: Vec<Uuid> = (0..n).map(|_| Uuid::new_v4()).collect();
        let mut sql = format!(
            "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
             VALUES ('{org}', '{entity}', true, 'MIGRATION');"
        );
        for w in &workplaces {
            sql.push_str(&format!(
                "INSERT INTO workplaces (org_id, id, legal_entity_id, needs_confirmation, \
                 created_change_mode) VALUES ('{org}', '{w}', '{entity}', true, 'MIGRATION');"
            ));
        }
        seed(&self.owner, org, sql).await;
        (entity, workplaces)
    }

    /// The employee's live HIRE assignment from the hire date.
    async fn place(&self, entity: Uuid, workplace: Uuid) {
        self.place_from(entity, workplace, HIRE).await;
    }

    async fn place_from(&self, entity: Uuid, workplace: Uuid, from: &str) {
        let (org, employee, user) = (self.org, self.employee, self.user);
        seed(
            &self.owner,
            org,
            format!(
                "INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, \
                 workplace_id, valid_from, cause, actor_id, command_id) VALUES ('{org}', \
                 '{employee}', '{entity}', '{workplace}', '{from}', 'HIRE', '{user}', \
                 gen_random_uuid())"
            ),
        )
        .await;
    }

    /// An active department sitting at `workplace`.
    async fn unit_at(&self, entity: Uuid, workplace: Uuid) -> Uuid {
        let (org, user, unit) = (self.org, self.user, Uuid::new_v4());
        seed(
            &self.owner,
            org,
            format!(
                "INSERT INTO org_units (org_id, id) VALUES ('{org}', '{unit}'); \
                 INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, \
                 actor_id, payload_digest, attributes, receipt) VALUES ('{org}', '{unit}', 1, \
                 gen_random_uuid(), '{user}', decode(repeat('ab', 32), 'hex'), \
                 '{{\"kind\": \"department\", \"name\": \"부산영업팀\"}}', '{{}}'); \
                 INSERT INTO org_unit_placements (org_id, org_unit_id, legal_entity_id, \
                 workplace_id, valid_from, change_mode, command_id) VALUES ('{org}', '{unit}', \
                 '{entity}', '{workplace}', '2026-01-01', 'MIGRATION', gen_random_uuid())"
            ),
        )
        .await;
        unit
    }

    /// Live assignment rows, oldest first: `(from, to, workplace, cause)`.
    async fn live(&self) -> Vec<(String, Option<String>, Option<Uuid>, String)> {
        let rows: Vec<(Date, Option<Date>, Option<Uuid>, String)> = sqlx::query_as(
            "SELECT valid_from, valid_to, workplace_id, cause FROM employment_assignments \
             WHERE employee_id = $1 AND superseded_at IS NULL ORDER BY valid_from",
        )
        .bind(self.employee)
        .fetch_all(&self.owner)
        .await
        .unwrap();
        rows.into_iter()
            .map(|(f, t, w, c)| (f.to_string(), t.map(|d| d.to_string()), w, c))
            .collect()
    }

    async fn record(&self, body: Value) -> Result<Value, (u16, String)> {
        let body: CreateEmployeeLifecycleEventRequest = serde_json::from_value(body).unwrap();
        self.hr
            .record_lifecycle_event(
                self.principal.clone(),
                self.employee,
                Uuid::new_v4().to_string(),
                body,
            )
            .await
            .map_err(|e| (e.status.as_u16(), e.code.to_owned()))
    }

    /// Lifecycle audits badged `setup` (a leave or transfer in SETUP).
    async fn setup_records(&self) -> i64 {
        let mut tx = self.owner.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(self.org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE org_id = $1 \
             AND action = 'employee.lifecycle.record' \
             AND classification_badges @> ARRAY['setup'] \
             AND after_snap->>'change_mode' = 'SETUP'",
        )
        .bind(self.org)
        .fetch_one(tx.as_mut())
        .await
        .unwrap()
    }

    async fn rescind(&self, event: &Value) {
        let id = Uuid::parse_str(event["id"].as_str().unwrap()).unwrap();
        let request: RescindLifecycleEventRequest =
            serde_json::from_value(json!({"reason_code": "INPUT_ERROR", "confirm_cascades": true}))
                .unwrap();
        self.hr
            .rescind_lifecycle_event(self.principal.clone(), self.employee, id, request)
            .await
            .unwrap();
    }
}

fn event(kind: &str, on: &str, extra: Value) -> Value {
    let mut body = json!({"event_type": kind, "effective_date": on, "comment": "E-S3b"});
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    body
}

const HIRE: &str = "2026-01-02";
