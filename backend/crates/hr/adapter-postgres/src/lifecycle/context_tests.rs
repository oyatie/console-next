// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::{
    guards::{RecordGuards, check_record_guards_with_facts},
    normalize::normalize_lifecycle_transition,
    prepare::prepare_lifecycle_event_with_context,
    schedule_sql::load_schedules_many,
    store::load_employee_heads,
};
use crate::clock::today_kst;
use console_kernel_core::OrgId;
use serde_json::json;
use sqlx::PgPool;
use time::Duration;
use uuid::Uuid;

async fn person(pool: &PgPool) -> (Uuid, Uuid, Uuid) {
    let (org, employee, actor) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES ($1,$2,'발령 테스트')")
        .bind(org)
        .bind(org.to_string())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users(id,org_id,display_name,roles) VALUES ($1,$2,'인사 담당','{}')")
        .bind(actor)
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO employees(id,org_id,company,name,source_filename,source_sheet,source_row,source_key,hire_date) \
        VALUES ($1,$2,'Co','김계약','console','console',1,$3,$4)")
        .bind(employee).bind(org).bind(employee.to_string()).bind(today_kst().to_string()).execute(pool).await.unwrap();
    (org, employee, actor)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn batched_contract_end_facts_accept_the_current_pin_and_refuse_a_stale_pin(pool: PgPool) {
    let (org, employee, actor) = person(&pool).await;
    let on = today_kst();
    let end = on + Duration::days(90);
    sqlx::query("INSERT INTO employee_employment_profiles(employee_id,org_id,employment_type,phone_e164,base_pay,idempotency_key,request_hash,created_by,contract_start_date,contract_end_date) \
        VALUES ($1,$2,'CONTRACT','+821012345678',3000000,$3,$4,$5,$6,$7)")
        .bind(employee).bind(org).bind(employee.to_string()).bind("0".repeat(64)).bind(actor).bind(on).bind(end)
        .execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    for (pin, refused) in [(end, false), (end - Duration::days(1), true)] {
        let head = load_employee_heads(&mut tx, org, &[employee])
            .await
            .unwrap()
            .remove(&employee)
            .unwrap();
        assert_eq!(head.current.contract_end_date, Some(end));
        let transition = normalize_lifecycle_transition(
            serde_json::from_value(json!({
                "event_type":"CONTRACT_RENEWAL","effective_date":on.to_string(),
                "contract_end_date":(end+Duration::days(30)).to_string(),"comment":"계약 갱신"
            }))
            .unwrap(),
        )
        .unwrap();
        let mut prepared = prepare_lifecycle_event_with_context(
            &mut tx,
            org,
            employee,
            transition,
            on,
            Some((Some(&head.current), &[])),
        )
        .await
        .unwrap();
        let result = check_record_guards_with_facts(
            &mut tx,
            OrgId::from_uuid(org),
            employee,
            &mut prepared,
            &RecordGuards {
                expected_contract_end_date: Some(pin.to_string()),
                ..Default::default()
            },
            head.guards,
        )
        .await;
        if refused {
            let error = result.unwrap_err();
            assert_eq!((error.status.as_u16(), error.code), (409, "stale_record"));
        } else {
            result.unwrap();
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn batched_schedules_preserve_exit_ownership_instead_of_replacing_the_exit(pool: PgPool) {
    let (org, employee, actor) = person(&pool).await;
    let on = today_kst() + Duration::days(10);
    let transition: console_hr_domain::lifecycle::event::NormalizedEmployeeLifecycleTransition = serde_json::from_value(json!({
        "event_type":"TERMINATE","to_status":"EXITED","effective_date":on.to_string(),"comment":"퇴직 예약",
        "signoffs":{"privacy_notice_ack":true,"korean_labor_law_ack":true,"payroll_cutoff_ack":true,"retirement_settlement_ack":true}
    })).unwrap();
    let event: Uuid = sqlx::query_scalar("INSERT INTO employee_lifecycle_events(org_id,employee_id,event_type,from_status,to_status,effective_date,comment,created_by,state,scheduled_request) \
        VALUES ($1,$2,'TERMINATE','ACTIVE','EXITED',$3,'퇴직 예약',$4,'SCHEDULED',$5) RETURNING id")
        .bind(org).bind(employee).bind(on.to_string()).bind(actor).bind(serde_json::to_value(&transition).unwrap())
        .fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO employee_exit_cases(org_id,employee_id,effective_exit_date,site_manager_note,reported_by,exit_lifecycle_event_id) VALUES ($1,$2,$3,'퇴직 신고',$4,$5)")
        .bind(org).bind(employee).bind(on).bind(actor).bind(event).execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    let head = load_employee_heads(&mut tx, org, &[employee])
        .await
        .unwrap()
        .remove(&employee)
        .unwrap();
    let rows = load_schedules_many(&mut tx, org, &[employee])
        .await
        .unwrap()
        .remove(&employee)
        .unwrap();
    let error = prepare_lifecycle_event_with_context(
        &mut tx,
        org,
        employee,
        transition,
        today_kst(),
        Some((Some(&head.current), &rows)),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "lifecycle_scheduled_state")
    );
    assert!(error.message.contains(&on.to_string()));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn batched_heads_do_not_admit_another_tenants_employee(pool: PgPool) {
    let (org, employee, _) = person(&pool).await;
    let (_, foreign, _) = person(&pool).await;
    // The owner connection bypasses RLS, so the loader must enforce its own tenant boundary.
    let mut tx = pool.begin().await.unwrap();
    let heads = load_employee_heads(&mut tx, org, &[employee, foreign])
        .await
        .unwrap();
    assert_eq!(heads.keys().copied().collect::<Vec<_>>(), vec![employee]);
    let transition = normalize_lifecycle_transition(
        serde_json::from_value(json!({
            "event_type":"APPOINT", "to_job":"개발", "effective_date":today_kst().to_string(),
            "comment":"직무 발령"
        }))
        .unwrap(),
    )
    .unwrap();
    let error = prepare_lifecycle_event_with_context(
        &mut tx,
        org,
        foreign,
        transition,
        today_kst(),
        Some((heads.get(&foreign).map(|head| &head.current), &[])),
    )
    .await
    .err()
    .expect("a foreign head must not be available to bulk preparation");
    assert_eq!((error.status.as_u16(), error.code), (404, "not_found"));
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn batched_schedules_do_not_read_another_tenants_reservations(pool: PgPool) {
    let (org, employee, actor) = person(&pool).await;
    let (foreign_org, foreign, foreign_actor) = person(&pool).await;
    let on = today_kst() + Duration::days(10);
    for (tenant, id, by) in [
        (org, employee, actor),
        (foreign_org, foreign, foreign_actor),
    ] {
        sqlx::query("INSERT INTO employee_lifecycle_events(org_id,employee_id,event_type,from_status,to_status,effective_date,comment,created_by,state,scheduled_request) \
            VALUES ($1,$2,'APPOINT','ACTIVE','ACTIVE',$3,'직무 발령',$4,'SCHEDULED',$5)")
            .bind(tenant).bind(id).bind(on.to_string()).bind(by)
            .bind(json!({"event_type":"APPOINT","to_status":"ACTIVE","to_job":"개발",
                "effective_date":on.to_string(),"comment":"직무 발령","signoffs":{}}))
            .execute(&pool).await.unwrap();
    }
    let mut tx = pool.begin().await.unwrap();
    let schedules = load_schedules_many(&mut tx, org, &[employee, foreign])
        .await
        .unwrap();
    assert_eq!(
        schedules.keys().copied().collect::<Vec<_>>(),
        vec![employee],
        "a mixed-tenant selection must return only this tenant's reservations"
    );
    let heads = load_employee_heads(&mut tx, org, &[employee])
        .await
        .unwrap();
    let mut transition = normalize_lifecycle_transition(serde_json::from_value(json!({
        "event_type":"APPOINT","to_job":"영업","effective_date":on.to_string(),"comment":"직무 정정"
    })).unwrap()).unwrap();
    let (_, replaces) = super::schedule_sql::replay_loaded_schedule(
        &schedules[&employee],
        &heads[&employee].current,
        console_hr_domain::lifecycle::schedule::ScheduleChange::Insert(&mut transition),
    )
    .expect("the local reservation remains replaceable with foreign data present");
    assert_eq!(replaces, Some(schedules[&employee][0].id));
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_group_transfer_linked_to_an_exit_case_remains_replaceable(pool: PgPool) {
    let (org, employee, actor) = person(&pool).await;
    let on = today_kst() + Duration::days(10);
    let request = json!({"event_type":"GROUP_TRANSFER","to_status":"ACTIVE","to_company":"Receiving Co",
        "effective_date":on.to_string(),"comment":"전적 예약","signoffs":{}});
    let event: Uuid = sqlx::query_scalar("INSERT INTO employee_lifecycle_events(org_id,employee_id,event_type,from_status,to_status,effective_date,comment,created_by,state,scheduled_request) \
        VALUES ($1,$2,'GROUP_TRANSFER','ACTIVE','ACTIVE',$3,'전적 예약',$4,'SCHEDULED',$5) RETURNING id")
        .bind(org).bind(employee).bind(on.to_string()).bind(actor).bind(&request)
        .fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO employee_exit_cases(org_id,employee_id,effective_exit_date,site_manager_note,reported_by,exit_lifecycle_event_id) VALUES ($1,$2,$3,'전적 신고',$4,$5)")
        .bind(org).bind(employee).bind(on).bind(actor).bind(event).execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    let heads = load_employee_heads(&mut tx, org, &[employee])
        .await
        .unwrap();
    let schedules = load_schedules_many(&mut tx, org, &[employee])
        .await
        .unwrap();
    let mut transition = serde_json::from_value(request).unwrap();
    let (_, replaces) = super::schedule_sql::replay_loaded_schedule(
        &schedules[&employee],
        &heads[&employee].current,
        console_hr_domain::lifecycle::schedule::ScheduleChange::Insert(&mut transition),
    )
    .expect("linking a group transfer to its exit case must not prevent replacement");
    assert_eq!(
        replaces,
        Some(event),
        "group transfers keep same-date replacement semantics"
    );
    tx.rollback().await.unwrap();
}
