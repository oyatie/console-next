//! 전적 as one act (decisions #30): the sending 법인's settlement case opens
//! with the 전적, linked to it, and goes back only with it.

use console_hr_adapter_postgres::exits::types::CloseEmployeeExitCaseRequest;
use console_hr_adapter_postgres::lifecycle::requests::CancelLifecycleEventRequest;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use super::*;

fn group(on: &str, workplace: Uuid, dims: Value) -> Value {
    let mut facts = json!({
        "group_service_start_date": HIRE,
        "consent_date": day(-10),
        "consent_evidence_ref": "전적 동의서 (서명본)",
    });
    for (key, value) in dims.as_object().unwrap() {
        facts[key] = value.clone();
    }
    event(
        "GROUP_TRANSFER",
        on,
        json!({ "to_workplace_id": workplace, "group_transfer": facts }),
    )
}

fn settled() -> Value {
    json!({ "continuity": "SETTLED", "annual_leave_continuity": "SETTLED", "seniority_continuity": "RESTART" })
}

/// `(id, status, exit date, reason, exit event)` of the employee's exit cases, oldest first.
type CaseRow = (Uuid, String, String, Option<String>, Option<Uuid>);

impl Fixture {
    pub(super) async fn cases(&self) -> Vec<CaseRow> {
        sqlx::query_as(
            "SELECT id, status, effective_exit_date::TEXT, exit_reason_code, exit_lifecycle_event_id \
             FROM employee_exit_cases WHERE employee_id = $1 ORDER BY created_at, id",
        )
        .bind(self.employee)
        .fetch_all(&self.owner)
        .await
        .unwrap()
    }

    async fn packages(&self) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM employee_exit_settlement_packages WHERE employee_id = $1",
        )
        .bind(self.employee)
        .fetch_one(&self.owner)
        .await
        .unwrap()
    }

    async fn close_case(&self, case: Uuid, to: &'static str) -> (u16, String) {
        let body = CloseEmployeeExitCaseRequest {
            reason: "잘못 열림".to_owned(),
        };
        let err = self
            .hr
            .close_exit_case(self.principal.clone(), case, body, to)
            .await
            .unwrap_err();
        (err.status.as_u16(), err.code.to_owned())
    }
}

fn id(v: &Value) -> Uuid {
    Uuid::parse_str(v.as_str().unwrap()).unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_settled_group_transfer_opens_the_sending_entitys_settlement_case(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (a, wa) = f.entity(1).await;
    let (_, wb) = f.entity(1).await;
    f.place(a, wa[0]).await;
    let on = day(-2);

    let moved = f.record(group(&on, wb[0], settled())).await.unwrap();
    let facts = &moved["group_transfer"];
    assert_eq!(
        (
            &facts["continuity"],
            &facts["annual_leave_continuity"],
            &facts["seniority_continuity"]
        ),
        (&json!("SETTLED"), &json!("SETTLED"), &json!("RESTART"))
    );
    let cases = f.cases().await;
    assert_eq!(cases.len(), 1);
    let (case, status, exit_date, reason, linked) = cases[0].clone();
    assert_eq!(facts["settlement_case_id"], json!(case));
    assert_eq!(status, "HR_CONFIRMED");
    assert_eq!(
        exit_date,
        day(-3),
        "마지막 근무일 = the day before the start"
    );
    assert_eq!(reason.as_deref(), Some("GROUP_TRANSFER"));
    assert_eq!(linked, Some(id(&moved["id"])));
    assert_eq!(f.packages().await, 1);
    // The person is not exited: they work at the receiving 법인.
    let status: String =
        sqlx::query_scalar("SELECT employment_status FROM employees WHERE id = $1")
            .bind(f.employee)
            .fetch_one(&f.owner)
            .await
            .unwrap();
    assert_eq!(status, "ACTIVE");

    // The case moves forward only; its reject and cancel refuse and change nothing.
    let register = console_compliance_adapter_postgres::PgComplianceStore::new(f.owner.clone())
        .statutory_register()
        .await
        .unwrap();
    let read =
        f.hr.exit_case(f.principal.clone(), case, &register)
            .await
            .unwrap();
    let keys: Vec<&str> = read.next_actions.iter().map(|a| a.key.as_str()).collect();
    assert_eq!(keys, ["confirm_exit_hq"]);
    let windows = read.settlement_deadlines.unwrap();
    assert_eq!(windows.len(), 2);
    assert!(
        windows
            .iter()
            .all(|w| w.opens_on.as_deref() == Some(on.as_str()))
    );
    for to in ["REJECTED", "CANCELLED"] {
        assert_eq!(
            f.close_case(case, to).await,
            (409, "exit_case_follows_group_transfer".to_owned())
        );
    }
    assert_eq!(f.cases().await, cases);

    // Rescinding the 전적 takes the case with it.
    f.rescind(&moved).await;
    let after = f.cases().await;
    assert_eq!(after[0].1, "CANCELLED");
    assert_eq!(f.packages().await, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn carried_severance_opens_no_case_and_any_carried_dimension_needs_the_agreement(
    pool: PgPool,
) {
    let f = fixture(pool, true).await;
    let (a, wa) = f.entity(1).await;
    let (_, wb) = f.entity(1).await;
    f.place(a, wa[0]).await;
    let on = day(-2);
    let leave_carried = json!({ "continuity": "SETTLED", "annual_leave_continuity": "CARRIED", "seniority_continuity": "RESTART" });
    assert_eq!(
        f.record(group(&on, wb[0], leave_carried))
            .await
            .unwrap_err(),
        (422, "validation".to_owned())
    );
    let half = json!({ "continuity": "SETTLED", "annual_leave_continuity": "SETTLED" });
    assert_eq!(
        f.record(group(&on, wb[0], half)).await.unwrap_err(),
        (422, "validation".to_owned())
    );
    assert!(f.cases().await.is_empty());

    let carried = json!({ "continuity": "CARRIED", "annual_leave_continuity": "CARRIED",
        "seniority_continuity": "CARRIED", "succession_evidence_ref": "포괄 승계 합의서" });
    let moved = f.record(group(&on, wb[0], carried)).await.unwrap();
    assert_eq!(moved["group_transfer"]["seniority_continuity"], "CARRIED");
    assert!(moved["group_transfer"].get("settlement_case_id").is_none());
    assert!(f.cases().await.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_scheduled_group_transfer_takes_its_case_when_withdrawn_or_replaced(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (a, wa) = f.entity(1).await;
    let (_, wb) = f.entity(1).await;
    f.place(a, wa[0]).await;
    let on = day(5);

    let first = f.record(group(&on, wb[0], settled())).await.unwrap();
    assert_eq!(first["state"], "SCHEDULED");
    let case = f.cases().await[0].0;
    // The same 전적 again on its date replaces it, explicitly, and its case with it.
    let mut again = group(&on, wb[0], settled());
    again["replaces_event_id"] = first["id"].clone();
    again["replace_reason_code"] = json!("SCHEDULE_CHANGED");
    let second = f.record(again).await.unwrap();
    let cases = f.cases().await;
    assert_eq!(cases.len(), 2);
    assert_eq!((cases[0].0, cases[0].1.as_str()), (case, "CANCELLED"));
    assert_eq!(cases[1].1, "HR_CONFIRMED");
    assert_eq!(cases[1].4, Some(id(&second["id"])));

    // Withdrawing the reservation withdraws its case.
    let body = CancelLifecycleEventRequest {
        reason: "계획 철회".to_owned(),
    };
    f.hr.cancel_lifecycle_event(f.principal.clone(), f.employee, id(&second["id"]), body)
        .await
        .unwrap();
    assert_eq!(f.cases().await[1].1, "CANCELLED");
    assert_eq!(f.packages().await, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_open_exit_case_refuses_the_group_transfer_and_nothing_is_written(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (a, wa) = f.entity(1).await;
    let (_, wb) = f.entity(1).await;
    f.place(a, wa[0]).await;
    let (org, employee, user) = (f.org, f.employee, f.user);
    seed(&f.owner, org, format!(
        "INSERT INTO employee_exit_cases (org_id, employee_id, effective_exit_date, site_manager_note, reported_by) \
         VALUES ('{org}', '{employee}', '{}', '퇴사 의사', '{user}')", day(20))).await;
    let (before, events, cases) = (f.live().await, f.events().await, f.cases().await);
    assert_eq!(
        f.record(group(&day(-2), wb[0], settled()))
            .await
            .unwrap_err(),
        (409, "exit_case_open".to_owned())
    );
    assert_eq!(f.live().await, before);
    assert_eq!(f.events().await, events);
    assert_eq!(f.cases().await, cases);
    let facts: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_group_transfers WHERE employee_id = $1")
            .bind(f.employee)
            .fetch_one(&f.owner)
            .await
            .unwrap();
    assert_eq!(facts, 0);
}

/// A scheduled 전적 that failed to apply on its date moved nobody: its case
/// is an ordinary dead case and closes on its own (no dead end).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_group_transfer_that_failed_to_apply_leaves_a_case_that_closes_alone(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (a, wa) = f.entity(1).await;
    let (_, wb) = f.entity(1).await;
    f.place(a, wa[0]).await;
    let moved = f.record(group(&day(5), wb[0], settled())).await.unwrap();
    let case = f.cases().await[0].0;
    assert_eq!(
        f.close_case(case, "CANCELLED").await,
        (409, "exit_case_follows_group_transfer".to_owned())
    );
    let (org, event) = (f.org, id(&moved["id"]));
    seed(&f.owner, org, format!(
        "UPDATE employee_lifecycle_events SET state = 'APPLY_FAILED', failure_code = 'x', failure_reason = 'x' WHERE id = '{event}'")).await;
    let body = CloseEmployeeExitCaseRequest {
        reason: "전적 무산".to_owned(),
    };
    let closed =
        f.hr.close_exit_case(f.principal.clone(), case, body, "REJECTED")
            .await
            .unwrap();
    assert_eq!(closed.status, "REJECTED");
    assert_eq!(f.packages().await, 0);
}
