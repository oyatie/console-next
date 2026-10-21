#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-13 through the `HrService` entry points the routes call, on a
//! `console_rt` pool (so 0261's grants, RLS and the leave trigger are what is
//! proved): required leave facts, PROMOTE by catalog id with the 강등 reason,
//! and the job-title catalog.

#[path = "support/go_live.rs"]
mod go_live;
use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::job_title::CreateJobTitleRequest;
use console_hr_adapter_postgres::lifecycle::requests::CreateEmployeeLifecycleEventRequest;
use console_hr_domain::lifecycle::signoffs::EmployeeLifecycleSignoffs;
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use serde_json::Value;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

struct Fixture {
    hr: HrService,
    owner: PgPool,
    principal: Principal,
    org: Uuid,
    user: Uuid,
    employee: Uuid,
}

async fn fixture(pool: PgPool) -> Fixture {
    let (org, user) = (OrgId::new(), UserId::new());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'BW-13 test org')")
        .bind(*org.as_uuid())
        .bind(format!(
            "bw13-{}",
            &org.as_uuid().simple().to_string()[..12]
        ))
        .execute(&pool)
        .await
        .unwrap();
    go_live::go_live(&pool, *org.as_uuid()).await;
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'HR', $2, $3)")
        .bind(*user.as_uuid())
        .bind(["SUPER_ADMIN"])
        .bind(*org.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, position, source_filename, source_sheet, \
         source_row, source_key, hire_date) \
         VALUES ($1, 'Co', '정하늘', '사원', 'console', 'console', 1, $2, '2026-01-02') RETURNING id",
    )
    .bind(*org.as_uuid())
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
        user,
        org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    Fixture {
        hr: HrService::new(rt),
        owner: pool,
        principal,
        org: *org.as_uuid(),
        user: *user.as_uuid(),
        employee,
    }
}

fn event(event_type: &str) -> CreateEmployeeLifecycleEventRequest {
    serde_json::from_value(serde_json::json!({
        "event_type": event_type,
        "effective_date": "2026-09-01",
        "comment": "BW-13",
        "signoffs": EmployeeLifecycleSignoffs {
            privacy_notice_ack: true,
            korean_labor_law_ack: true,
            payroll_cutoff_ack: true,
            retirement_settlement_ack: false,
        },
    }))
    .unwrap()
}

impl Fixture {
    async fn record(
        &self,
        body: CreateEmployeeLifecycleEventRequest,
    ) -> Result<Value, (u16, String)> {
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

    async fn title(&self, label: &str, rank: i32, active: bool) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO job_titles (org_id, kind, label, grade_rank, active, created_by) \
             VALUES ($1, 'TITLE', $2, $3, $4, $5) RETURNING id",
        )
        .bind(self.org)
        .bind(label)
        .bind(rank)
        .bind(active)
        .bind(self.user)
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }

    async fn head(&self) -> (Option<String>, Option<Uuid>) {
        sqlx::query_as("SELECT position, job_title_id FROM employees WHERE id = $1")
            .bind(self.employee)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_leave_names_its_type_and_statutory_leaves_their_return(pool: PgPool) {
    let f = fixture(pool).await;
    let refused = f.record(event("LEAVE_OF_ABSENCE")).await.unwrap_err();
    assert_eq!(refused, (422, "leave_type_required".to_owned()));
    let mut childcare = event("LEAVE_OF_ABSENCE");
    childcare.leave_type = Some("CHILDCARE".to_owned());
    assert_eq!(
        f.record(childcare).await.unwrap_err(),
        (422, "leave_return_date_required".to_owned())
    );
    // The trigger refuses the same row from any writer.
    let raw = sqlx::query(
        "INSERT INTO employee_lifecycle_events (org_id, employee_id, event_type, to_status, \
         effective_date, comment, created_by) \
         VALUES ($1, $2, 'LEAVE_OF_ABSENCE', 'ON_LEAVE', '2026-09-01', 'x', $3)",
    )
    .bind(f.org)
    .bind(f.employee)
    .bind(f.user)
    .execute(&f.owner)
    .await
    .unwrap_err();
    assert_eq!(
        raw.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );

    let mut illness = event("LEAVE_OF_ABSENCE");
    illness.leave_type = Some("ILLNESS".to_owned());
    let recorded = f.record(illness).await.unwrap();
    assert_eq!(recorded["leave_type"], "ILLNESS");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_promotion_by_title_sets_the_head_and_a_lower_grade_needs_the_demotion_code(
    pool: PgPool,
) {
    let f = fixture(pool).await;
    let senior = f.title("과장", 5, true).await;
    let junior = f.title("대리", 3, true).await;
    let retired = f.title("주임", 2, false).await;

    let mut up = event("PROMOTE");
    up.to_job_title_id = Some(senior);
    up.to_position = Some("ignored when an id is given".to_owned());
    up.reason_code = Some("REGULAR_PROMOTION".to_owned());
    let recorded = f.record(up).await.unwrap();
    assert_eq!(recorded["to_position"], "과장");
    assert_eq!(recorded["reason_code"], "REGULAR_PROMOTION");
    assert_eq!(recorded["to_job_title_id"], senior.to_string());
    assert_eq!(f.head().await, (Some("과장".to_owned()), Some(senior)));

    let down = |reason: Option<&str>| {
        let mut body = event("PROMOTE");
        body.to_job_title_id = Some(junior);
        body.reason_code = reason.map(str::to_owned);
        body
    };
    for reason in [None, Some("REGULAR_PROMOTION")] {
        assert_eq!(
            f.record(down(reason)).await.unwrap_err(),
            (422, "demotion_reason_required".to_owned())
        );
    }
    assert_eq!(
        f.record(down(Some("NOT_A_CODE"))).await.unwrap_err(),
        (422, "reason_code_invalid".to_owned())
    );
    let demoted = f.record(down(Some("DISCIPLINARY_DEMOTION"))).await.unwrap();
    assert_eq!(demoted["from_job_title_id"], senior.to_string());
    assert_eq!(f.head().await, (Some("대리".to_owned()), Some(junior)));

    let mut inactive = event("PROMOTE");
    inactive.to_job_title_id = Some(retired);
    assert_eq!(
        f.record(inactive).await.unwrap_err(),
        (422, "job_title_unknown".to_owned())
    );
    // Free text still promotes (no dead end before the catalog is filled) and
    // clears the now-stale catalog title.
    let mut text = event("PROMOTE");
    text.to_position = Some("팀장".to_owned());
    f.record(text).await.unwrap();
    assert_eq!(f.head().await, (Some("팀장".to_owned()), None));

    let mut leave_reason = event("LEAVE_OF_ABSENCE");
    leave_reason.leave_type = Some("PERSONAL".to_owned());
    leave_reason.reason_code = Some("REGULAR_PROMOTION".to_owned());
    assert_eq!(f.record(leave_reason).await.unwrap_err().0, 422);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_catalog_lists_by_grade_and_its_holder_adds_through_cedar(pool: PgPool) {
    let f = fixture(pool).await;
    f.title("사원", 1, true).await;
    f.title("부장", 7, true).await;
    f.title("고문", 0, false).await;
    let labels: Vec<String> =
        f.hr.job_titles(f.principal.clone(), Default::default())
            .await
            .unwrap()
            .items
            .into_iter()
            .map(|t| t.label)
            .collect();
    assert_eq!(labels, ["부장", "사원", "고문"]);
    let add = CreateJobTitleRequest {
        kind: "TITLE".to_owned(),
        label: "차장".to_owned(),
        grade_rank: Some(6),
    };
    // BE-EMP-UI: job_title_manage is decided in Cedar; the tenant-wide org
    // holder adds (the refusals are pinned in tests/emp_ui/catalog.rs).
    let (added, created) =
        f.hr.create_job_title(f.principal.clone(), add)
            .await
            .unwrap();
    assert!(created);
    assert_eq!((added.label.as_str(), added.grade_rank), ("차장", Some(6)));
    // A label is unique per tenant and kind ignoring case.
    let dup = sqlx::query(
        "INSERT INTO job_titles (org_id, kind, label, created_by) VALUES ($1, 'TITLE', '부장', $2)",
    )
    .bind(f.org)
    .bind(f.user)
    .execute(&f.owner)
    .await
    .unwrap_err();
    assert_eq!(
        dup.as_database_error().unwrap().code().as_deref(),
        Some("23505")
    );
}
