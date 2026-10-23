#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-38 through the `HrService` entry points, on a `console_rt` pool: a
//! commit is one atomic batch, a stale line refuses the whole set, a refused
//! line rolls every line back, and nobody but the owner reaches a set.

mod access;

use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::change_sets::{
    CommitChangeSetRequest, OpenChangeSetRequest, PutChangeSetLineRequest,
};
use console_hr_adapter_postgres::clock::today_kst;
use console_hr_adapter_postgres::lifecycle::requests::CreateEmployeeLifecycleEventRequest;
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

struct Fixture {
    hr: HrService,
    owner: PgPool,
    me: Principal,
    other: Principal,
    a: Uuid,
    b: Uuid,
}

async fn user(pool: &PgPool, org: OrgId) -> Principal {
    let user = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'HR', $2, $3)")
        .bind(*user.as_uuid())
        .bind(["SUPER_ADMIN"])
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    Principal::new(
        user,
        org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
}

async fn employee(pool: &PgPool, org: OrgId, name: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, position, source_filename, source_sheet, \
         source_row, source_key, hire_date) \
         VALUES ($1, 'Co', $2, '사원', 'console', 'console', 1, $3, '2026-01-02') RETURNING id",
    )
    .bind(*org.as_uuid())
    .bind(name)
    .bind(Uuid::new_v4().to_string())
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn fixture(pool: PgPool) -> Fixture {
    let org = OrgId::new();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'BW-38 test org')")
        .bind(*org.as_uuid())
        .bind(format!(
            "bw38-{}",
            &org.as_uuid().simple().to_string()[..12]
        ))
        .execute(&pool)
        .await
        .unwrap();
    let (me, other) = (user(&pool, org).await, user(&pool, org).await);
    let (a, b) = (
        employee(&pool, org, "정하늘").await,
        employee(&pool, org, "한바다").await,
    );
    let options = pool.connect_options().as_ref().clone();
    let rt = PgPoolOptions::new()
        .max_connections(4)
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
    Fixture {
        hr: HrService::new(rt),
        owner: pool,
        me,
        other,
        a,
        b,
    }
}

fn line(employee_id: Uuid, to: &str) -> PutChangeSetLineRequest {
    serde_json::from_value(json!({
        "employee_id": employee_id,
        "to_position": to,
        "effective_date": today_kst().to_string(),
        "comment": "BW-38",
    }))
    .unwrap()
}

fn signed() -> CommitChangeSetRequest {
    serde_json::from_value(json!({
        "signoffs": {"privacy_notice_ack": true, "korean_labor_law_ack": true}
    }))
    .unwrap()
}

fn promote() -> OpenChangeSetRequest {
    OpenChangeSetRequest {
        intent: "PROMOTE".to_owned(),
    }
}

fn key() -> Option<String> {
    Some(format!("bw38-{}", Uuid::new_v4()))
}

impl Fixture {
    async fn open_with_lines(&self, lines: &[(Uuid, &str)]) -> Uuid {
        let set = self
            .hr
            .open_change_set(self.me.clone(), promote())
            .await
            .unwrap()
            .summary
            .id;
        for (employee_id, to) in lines {
            self.hr
                .put_change_set_line(self.me.clone(), set, line(*employee_id, to))
                .await
                .unwrap();
        }
        set
    }

    async fn events(&self, employee_id: Uuid) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM employee_lifecycle_events WHERE employee_id = $1")
            .bind(employee_id)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }

    async fn state(&self, set: Uuid) -> String {
        sqlx::query_scalar("SELECT state FROM change_sets WHERE id = $1")
            .bind(set)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }
}

fn wire(e: console_hr_adapter_postgres::HrError) -> (u16, String, Value) {
    (
        e.status.as_u16(),
        e.code.to_owned(),
        *e.refusals.unwrap_or_default(),
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_commit_records_every_line_as_one_batch_and_closes_the_set(pool: PgPool) {
    let f = fixture(pool).await;
    let set = f.open_with_lines(&[(f.a, "과장"), (f.b, "대리")]).await;
    // Redrafting a line keeps one line per employee.
    f.hr.put_change_set_line(f.me.clone(), set, line(f.b, "차장"))
        .await
        .unwrap();
    let open = f.hr.change_sets(f.me.clone()).await.unwrap();
    assert_eq!(
        (open.len(), open[0].line_count, open[0].stale_count),
        (1, 2, 0)
    );

    let k = key();
    let done =
        f.hr.commit_change_set(f.me.clone(), set, k.clone(), signed())
            .await
            .unwrap();
    let items = done["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|i| i["batch_id"] == done["batch_id"]));
    let positions: BTreeSet<&str> = items
        .iter()
        .map(|i| i["to_position"].as_str().unwrap())
        .collect();
    assert_eq!(positions, BTreeSet::from(["과장", "차장"]));
    assert_eq!(f.state(set).await, "COMMITTED");
    assert!(f.hr.change_sets(f.me.clone()).await.unwrap().is_empty());

    // The same key replays; a fresh one meets a closed set.
    let again =
        f.hr.commit_change_set(f.me.clone(), set, k, signed())
            .await
            .unwrap();
    assert_eq!(again, done);
    let closed =
        f.hr.commit_change_set(f.me.clone(), set, key(), signed())
            .await
            .unwrap_err();
    assert_eq!(wire(closed).0, 409);
    let late =
        f.hr.put_change_set_line(f.me.clone(), set, line(f.a, "부장"))
            .await
            .unwrap_err();
    assert_eq!(wire(late).1, "invalid_transition");
    assert_eq!(f.events(f.a).await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_stale_line_refuses_the_whole_commit(pool: PgPool) {
    let f = fixture(pool).await;
    let set = f.open_with_lines(&[(f.a, "과장"), (f.b, "대리")]).await;
    // Someone records a change on A after the line was drafted.
    let direct: CreateEmployeeLifecycleEventRequest = serde_json::from_value(json!({
        "event_type": "PROMOTE", "to_position": "주임",
        "effective_date": today_kst().to_string(), "comment": "direct",
        "signoffs": {"privacy_notice_ack": true, "korean_labor_law_ack": true},
    }))
    .unwrap();
    f.hr.record_lifecycle_event(f.other.clone(), f.a, Uuid::new_v4().to_string(), direct)
        .await
        .unwrap();

    let detail = f.hr.change_set(f.me.clone(), set).await.unwrap();
    assert_eq!(detail.summary.stale_count, 1);
    assert!(detail.lines.iter().any(|l| l.employee_id == f.a && l.stale));

    let (status, code, refusals) = wire(
        f.hr.commit_change_set(f.me.clone(), set, key(), signed())
            .await
            .unwrap_err(),
    );
    assert_eq!((status, code.as_str()), (409, "stale_record"));
    assert_eq!(refusals.as_array().unwrap().len(), 1);
    assert_eq!(refusals[0]["employee_id"], json!(f.a));
    assert_eq!((f.events(f.a).await, f.events(f.b).await), (1, 0));
    assert_eq!(f.state(set).await, "OPEN");

    // Redrafting A against the new version clears it, and the commit goes through.
    f.hr.put_change_set_line(f.me.clone(), set, line(f.a, "과장"))
        .await
        .unwrap();
    f.hr.commit_change_set(f.me.clone(), set, key(), signed())
        .await
        .unwrap();
    assert_eq!((f.events(f.a).await, f.events(f.b).await), (2, 1));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_refused_line_rolls_every_line_back(pool: PgPool) {
    let f = fixture(pool).await;
    // B already holds 사원: a no-op PROMOTE, refused at commit.
    let set = f.open_with_lines(&[(f.a, "과장"), (f.b, "사원")]).await;
    let (status, code, refusals) = wire(
        f.hr.commit_change_set(f.me.clone(), set, key(), signed())
            .await
            .unwrap_err(),
    );
    assert_eq!((status, code.as_str()), (422, "bulk_lifecycle_refused"));
    assert_eq!(refusals[0]["employee_id"], json!(f.b));
    assert_eq!(refusals[0]["code"], "lifecycle_noop");
    assert_eq!((f.events(f.a).await, f.events(f.b).await), (0, 0));
    assert_eq!(f.state(set).await, "OPEN");

    // Without the signoffs every line is refused, still nothing written.
    let unsigned = serde_json::from_value(json!({"signoffs": {}})).unwrap();
    let refused =
        f.hr.commit_change_set(f.me.clone(), set, key(), unsigned)
            .await
            .unwrap_err();
    assert_eq!(wire(refused).1, "bulk_lifecycle_refused");
    assert_eq!(f.events(f.a).await, 0);
}
