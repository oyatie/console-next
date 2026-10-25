// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The real REST boundary keeps statutory refusals typed and correlated.
#[path = "support/go_live.rs"]
mod go_live;
#[path = "support/http.rs"]
mod support;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{Ctx, ctx, employee_body, structure, tenant};
use uuid::Uuid;

fn acks() -> Value {
    json!({"privacy_notice_ack":true,"korean_labor_law_ack":true,"payroll_cutoff_ack":true,"retirement_settlement_ack":true})
}

#[path = "legal_guards_api/renewal.rs"]
mod renewal;
async fn fixture(pool: &PgPool) -> (Ctx, String, String, String) {
    let (org, user) = tenant(pool, &["SUPER_ADMIN"]).await;
    let c = ctx(pool, org, user, &["SUPER_ADMIN"], None).await;
    let (_, _, branch, unit) = structure(&c).await;
    let mut body = employee_body("LEGAL-1", &branch, &unit);
    // These dated legal scenarios need their original continuous-service period.
    body["hire_date"] = json!("2026-01-02");
    let (s, e) = c.call("POST", "/api/v1/employees", Some(body)).await;
    assert_eq!(s, StatusCode::CREATED, "{e}");
    go_live::go_live(pool, org).await;
    (
        c,
        e["employee"]["id"].as_str().unwrap().into(),
        branch,
        unit,
    )
}
fn refused(status: StatusCode, body: &Value, code: &str) {
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], code, "{body}");
    assert!(body["error"]["operation_id"].is_string(), "{body}");
}
async fn report(c: &Ctx, id: &str, reason: &str, on: &str) -> Value {
    let (s,v) = c.call("POST","/api/v1/hr/exit-cases",Some(json!({"employee_id":id,"effective_exit_date":on,"site_manager_note":"합성 퇴직 경위","exit_reason_code":reason}))).await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    v
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn short_notice_is_typed_and_pay_disposition_is_read_back(pool: PgPool) {
    let (c, id, _, _) = fixture(&pool).await;
    let case = report(&c, &id, "DISCIPLINARY_DISMISSAL", "2026-11-06").await;
    let path = format!(
        "/api/v1/hr/exit-cases/{}/confirm",
        case["id"].as_str().unwrap()
    );
    let mut body = json!({"signoffs":acks(),"dismissal_notice":{"reason_text":"합성 해고사유","served_on":"2026-10-23","method":"CERTIFIED_MAIL","evidence_ref":"synthetic-receipt"}});
    let (s, v) = c.call("POST", &path, Some(body.clone())).await;
    refused(s, &v, "dismissal_notice_short");
    let (s, preflight) = c.call("GET", &format!("/api/v1/employees/{id}/exit-guards?effective_exit_date=2026-11-06&exit_reason_code=DISCIPLINARY_DISMISSAL&dismissal_notice_served_on=2026-10-23"), None).await;
    assert_eq!(s, StatusCode::OK, "{preflight}");
    assert_eq!(preflight["refusal_code"], "dismissal_notice_short");
    assert_eq!(preflight["notice_pay"], v["error"]["refusals"][0]);
    assert!(
        v["error"]["refusals"][0]["rule"]["article"]
            .as_str()
            .unwrap()
            .contains("제26조")
    );
    body["notice_disposition"] = json!({"kind":"PAY_IN_LIEU"});
    let (s, v) = c.call("POST", &path, Some(body)).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["notice_pay"]["owed"], true);
    assert_eq!(v["notice_disposition"]["kind"], "PAY_IN_LIEU");
    assert_eq!(
        v["notice_pay"]["unavailable_reason"],
        "ordinary_wage_missing"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preflight_and_report_return_the_same_protected_period(pool: PgPool) {
    let (c, id, _, _) = fixture(&pool).await;
    let (s,v) = c.call("POST",&format!("/api/v1/employees/{id}/lifecycle-events"),Some(json!({"event_type":"LEAVE_OF_ABSENCE","leave_type":"CHILDCARE","effective_date":"2026-10-09","expected_return_date":"2027-01-01","comment":"합성 휴직","signoffs":acks()}))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let (s,preflight) = c.call("GET",&format!("/api/v1/employees/{id}/exit-guards?effective_exit_date=2026-10-10&exit_reason_code=DISCIPLINARY_DISMISSAL"),None).await;
    assert_eq!(s, StatusCode::OK, "{preflight}");
    assert_eq!(preflight["refusal_code"], "exit_protected_period");
    let (s,refusal) = c.call("POST","/api/v1/hr/exit-cases",Some(json!({"employee_id":id,"effective_exit_date":"2026-10-10","site_manager_note":"합성","exit_reason_code":"DISCIPLINARY_DISMISSAL"}))).await;
    refused(s, &refusal, "exit_protected_period");
    assert_eq!(preflight["protected_periods"], refusal["error"]["refusals"]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_record_routes_refuse_but_governed_correction_stays_available(pool: PgPool) {
    let (c, id, branch, _) = fixture(&pool).await;
    let fields = json!({"school":"합성대학교","level":"BACHELOR","major":"경영학","status":"GRADUATED","entered_on":"2010-03-01","ended_on":"2014-02-01"});
    let (s, entry) = c
        .call(
            "POST",
            &format!("/api/v1/employees/{id}/records/education"),
            Some(json!({"fields":fields})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{entry}");
    sqlx::query(
        "UPDATE employees SET employment_status='EXITED',exit_date='2026-10-10' WHERE id=$1",
    )
    .bind(id.parse::<Uuid>().unwrap())
    .execute(&pool)
    .await
    .unwrap();
    let (_, detail) = c
        .call("GET", &format!("/api/v1/employees/{id}"), None)
        .await;
    let at = detail["employee"]["updated_at"].clone();
    let root = format!("/api/v1/employees/{id}");
    for (method, path, body) in [
        (
            "POST",
            format!("{root}/records/education"),
            json!({"fields":fields}),
        ),
        (
            "PUT",
            format!("{root}/records/education/{}", entry["id"].as_str().unwrap()),
            json!({"fields":fields,"expected_version":entry["version"],"reason":"합성 정정"}),
        ),
        (
            "POST",
            format!(
                "{root}/records/education/{}/void",
                entry["id"].as_str().unwrap()
            ),
            json!({"expected_version":entry["version"],"reason":"합성 중복"}),
        ),
        (
            "PATCH",
            format!("{root}/employment-facts"),
            json!([{"op":"test","path":"/work_email","value":null},{"op":"replace","path":"/work_email","value":"synthetic@example.invalid"}]),
        ),
        (
            "POST",
            format!("{root}/probation/confirm"),
            json!({"expected":[]}),
        ),
        (
            "POST",
            format!("{root}/contracts"),
            json!({"kind":"OPEN_ENDED","start_date":"2026-10-10","wage_won":3000000,"pay_unit":"MONTHLY","weekly_minutes":2400}),
        ),
        (
            "POST",
            format!("{root}/employee-number"),
            json!({"new_number":"LEGAL-2","effective_date":"2026-10-10","expected_updated_at":at,"reason_code":"NUMBERING_SCHEME_CHANGE"}),
        ),
        (
            "PUT",
            format!("{root}/home-branch"),
            json!({"branch_id":branch,"expected_updated_at":at}),
        ),
        (
            "POST",
            "/api/v1/employment-assignments".into(),
            json!({"employee_id":id,"legal_entity_id":detail["employee"]["legal_entity_id"],"workplace_id":detail["employee"]["workplace_id"],"valid_from":"2026-10-11"}),
        ),
        #[cfg(feature = "payroll")]
        (
            "POST",
            format!("/api/v1/payroll/employees/{id}/contract-wages"),
            json!({"effective_from":"2026-10-10","wage_kind":"MONTHLY","amount_won":3000000,"monthly_standard_hours":209,"source_note":"synthetic contract wage"}),
        ),
    ] {
        let (s, v) = c.call(method, &path, Some(body)).await;
        refused(s, &v, "employee_exited_read_only");
    }
    let rows = json!([{"row":1,"employee_number":detail["employee"]["employee_number"],"fields":{
        "school":"합성대학원","level":"MASTER","major":"경영학","status":"GRADUATED","entered_on":"2014-03-01","ended_on":"2016-02-01"
    }}]);
    let (s, plan) = c
        .call(
            "POST",
            "/api/v1/employee-records/education/import/preview",
            Some(json!({"rows":rows})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{plan}");
    assert_eq!(plan["rows"][0]["outcome"], "CREATE", "{plan}");
    let (s, v) = c
        .call(
            "POST",
            "/api/v1/employee-records/education/import/apply",
            Some(json!({"rows":rows,"plan_digest":plan["plan_digest"]})),
        )
        .await;
    refused(s, &v, "employee_exited_read_only");
    assert!(detail["retention"]["kept_until"].is_string());
    let (s,v)=c.call("PATCH",&root,Some(json!({"expected_updated_at":at,"changes":{"job":"합성 정정 직무"},"reason_code":"DATA_ENTRY_ERROR"}))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let job: Option<String> = sqlx::query_scalar("SELECT job FROM employees WHERE id=$1")
        .bind(id.parse::<Uuid>().unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(job.as_deref(), Some("합성 정정 직무"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn renumber_undo_cannot_write_a_former_employee(pool: PgPool) {
    let (org, user) = tenant(&pool, &["SUPER_ADMIN"]).await;
    let c = ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (_, _, branch, unit) = structure(&c).await;
    let (s, e) = c
        .call(
            "POST",
            "/api/v1/employees",
            Some(employee_body("LEGAL-1", &branch, &unit)),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{e}");
    let request = json!({"scope_kind":"TENANT","prefix":"LEGAL-N","width":4,"effective_date":"2026-10-10","reason_code":"NUMBERING_SCHEME_CHANGE"});
    let (s, preview) = c
        .call(
            "POST",
            "/api/v1/employees/renumber/preview",
            Some(request.clone()),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{preview}");
    assert_eq!(preview["lines"].as_array().unwrap().len(), 1);
    let (s, applied) = c
        .call(
            "POST",
            "/api/v1/employees/renumber/apply",
            Some(json!({"request":request,"preview_digest":preview["preview_digest"]})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{applied}");
    sqlx::query(
        "UPDATE employees SET employment_status='EXITED',exit_date='2026-10-10' WHERE id=$1",
    )
    .bind(
        e["employee"]["id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap(),
    )
    .execute(&pool)
    .await
    .unwrap();
    let (s, preview) = c
        .call("POST", "/api/v1/employees/renumber/preview", Some(request))
        .await;
    assert_eq!(s, StatusCode::OK, "{preview}");
    assert!(preview["lines"].as_array().unwrap().is_empty(), "{preview}");
    let (s, v) = c
        .call(
            "POST",
            &format!(
                "/api/v1/employees/renumber/{}/undo",
                applied["batch_id"].as_str().unwrap()
            ),
            None,
        )
        .await;
    refused(s, &v, "employee_exited_read_only");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hire_basis_is_a_typed_refusal(pool: PgPool) {
    let (c, id, _, _) = fixture(&pool).await;
    let employee = id.parse::<Uuid>().unwrap();
    sqlx::query("UPDATE employee_employment_profiles SET employment_type='CONTRACT',contract_start_date=NULL,contract_end_date=NULL WHERE employee_id=$1").bind(employee).execute(&pool).await.unwrap();
    let (s,v)=c.call("POST",&format!("/api/v1/employees/{id}/lifecycle-events"),Some(json!({"event_type":"CONTRACT_RENEWAL","effective_date":"2026-10-10","contract_end_date":"2030-12-31","comment":"합성 갱신","signoffs":acks()}))).await;
    refused(s, &v, "fixed_term_basis_unconfirmed");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn open_exit_refuses_rehire_before_the_final_decision(pool: PgPool) {
    let (c, id, _, unit) = fixture(&pool).await;
    let employee = id.parse::<Uuid>().unwrap();
    sqlx::query(
        "UPDATE employees SET employment_status='EXITED',exit_date='2026-10-10' WHERE id=$1",
    )
    .bind(employee)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO employee_exit_cases (org_id,employee_id,status,effective_exit_date,site_manager_note,reported_by) VALUES ($1,$2,'HR_CONFIRMED','2026-10-10','합성',$3)").bind(c.org).bind(employee).bind(c.user.as_uuid()).execute(&pool).await.unwrap();
    let (s,v)=c.call("POST",&format!("/api/v1/employees/{id}/rehire"),Some(json!({"hire_date":"2026-10-11","employment_type":"REGULAR","org_unit_id":unit,"position":"사원","idempotency_key":Uuid::new_v4()}))).await;
    refused(s, &v, "rehire_exit_case_open");
}
