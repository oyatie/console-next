// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn maternity_boundary_and_case_read_share_the_same_register(pool: PgPool) {
    let w = live(&pool).await;
    // Synthetic January slice ends before sourced shipping coverage begins.
    sqlx::query("INSERT INTO statutory_rules (code,effective_from,effective_to_exclusive,unit,value_num,value_den,instrument_ko,article_ko,promulgation_ko,enforced_on,source_url,retrieved_on,provenance_ko) SELECT code,'2026-01-01','2026-08-20',unit,value_num,value_den,instrument_ko,article_ko,promulgation_ko,'2026-01-01',source_url,retrieved_on,'synthetic test slice' FROM statutory_rules WHERE code='DISMISSAL_PROTECTION_TAIL_DAYS' AND effective_from='2026-10-08'").execute(&pool).await.unwrap();
    let l = leave(&w, w.in_a, "MATERNITY", "2026-01-01", Some("2026-04-01")).await;
    w.hr.record_lifecycle_event(w.hr(w.hr_one),w.in_a,Uuid::new_v4().to_string(),serde_json::from_value(json!({"event_type":"RETURN_FROM_LEAVE","effective_date":"2026-04-01","comment":"합성 복귀","signoffs":acks()})).unwrap()).await.unwrap();
    for last in ["2026-04-28", "2026-04-29"] {
        let e = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), last)
            .await
            .unwrap_err();
        assert_eq!(e.code, "exit_protected_period");
        let p = &e.refusals.unwrap()[0];
        assert_eq!(p["leave_until"], "2026-03-31");
        assert_eq!(p["protected_until"], "2026-04-30");
        assert_eq!(p["lifecycle_event_id"], l["id"]);
    }
    let c = report(&w, w.in_a, Some("PERSONAL"), "2026-04-29")
        .await
        .unwrap();
    assert!(
        c["protected_periods"].as_array().unwrap().is_empty(),
        "health facts are computed on the authorized case read, never cached in the report receipt"
    );
    let id = c["id"].as_str().unwrap().parse::<Uuid>().unwrap();
    sqlx::query(
        "UPDATE employee_exit_cases SET exit_reason_code='DISCIPLINARY_DISMISSAL' WHERE id=$1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    let register = console_compliance_adapter_postgres::statutory::load_statutory_register(
        &mut pool.acquire().await.unwrap(),
    )
    .await
    .unwrap();
    let c = w.hr.exit_case(w.hr(w.hr_one), id, &register).await.unwrap();
    assert!(c.involuntary && c.notice_required);
    assert!(c.dismissal_notice.is_none());
    assert_eq!(
        c.protected_periods[0].protected_until.as_deref(),
        Some("2026-04-30")
    );
    let admin =
        w.hr.exit_case(w.admin(w.admin_a, w.branch_a), id, &register)
            .await
            .unwrap();
    assert_eq!(admin.protected_periods.len(), 1);
    let mut reader = w.admin(w.admin_a, w.branch_a);
    reader.roles = std::collections::BTreeSet::from([console_platform_authz::Role::Executive]);
    let masked = w.hr.exit_case(reader, id, &register).await.unwrap();
    assert!(masked.protected_periods.is_empty());
    assert!(masked.dismissal_notice.is_none());
    w.hr.close_exit_case(
        w.hr(w.hr_one),
        id,
        serde_json::from_value(json!({"reason":"합성 취소"})).unwrap(),
        "CANCELLED",
    )
    .await
    .unwrap();
    let c = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), "2026-04-30")
        .await
        .unwrap();
    assert_eq!(
        confirm(&w, &c, json!({"dismissal_notice":notice("2026-04-30")}))
            .await
            .unwrap()["status"],
        "HR_CONFIRMED"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn historical_protection_has_citations_and_does_not_extend_an_ended_tail(pool: PgPool) {
    let w = live(&pool).await;
    leave(&w, w.in_a, "MATERNITY", "2026-01-01", Some("2026-04-01")).await;
    // Before sourced coverage, fail closed while identifying the law requiring review.
    let error = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), "2026-08-18")
        .await
        .unwrap_err();
    let refusals = error.refusals.unwrap();
    assert_eq!(refusals[0]["instrument"], "근로기준법");
    assert!(
        refusals[0]["article"]
            .as_str()
            .unwrap()
            .starts_with("제23조제2항")
    );
    assert!(refusals[0]["protected_until"].is_null());
    for on in ["2026-08-19", "2026-10-01", "2026-10-07"] {
        let c = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), on)
            .await
            .unwrap();
        w.hr.close_exit_case(
            w.hr(w.hr_one),
            c["id"].as_str().unwrap().parse().unwrap(),
            serde_json::from_value(json!({"reason":"합성 취소"})).unwrap(),
            "CANCELLED",
        )
        .await
        .unwrap();
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ended_childcare_does_not_block_dismissal_in_the_august_law_slice(pool: PgPool) {
    let w = live(&pool).await;
    leave(&w, w.in_a, "CHILDCARE", "2026-03-02", Some("2026-06-01")).await;
    w.hr.record_lifecycle_event(w.hr(w.hr_one), w.in_a, Uuid::new_v4().to_string(), serde_json::from_value(json!({"event_type":"RETURN_FROM_LEAVE","effective_date":"2026-06-01","comment":"합성 복귀","signoffs":acks()})).unwrap()).await.unwrap();
    // The statutory exit day is the day after the last working day.
    for last in ["2026-08-19", "2026-09-10", "2026-09-16", "2026-09-17"] {
        let c = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), last)
            .await
            .unwrap();
        w.hr.close_exit_case(
            w.hr(w.hr_one),
            c["id"].as_str().unwrap().parse().unwrap(),
            serde_json::from_value(json!({"reason":"합성 취소"})).unwrap(),
            "CANCELLED",
        )
        .await
        .unwrap();
    }
    let c = report(&w, w.in_a, None, "2026-09-10").await.unwrap();
    assert_eq!(confirm(&w, &c, json!({"exit_reason_code":"DISCIPLINARY_DISMISSAL","dismissal_notice":notice("2026-09-10")})).await.unwrap()["status"], "HR_CONFIRMED");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rescinded_maternity_does_not_block_and_new_leave_does(pool: PgPool) {
    let w = live(&pool).await;
    let l = leave(&w, w.in_a, "MATERNITY", "2026-10-09", Some("2027-01-01")).await;
    w.hr.rescind_lifecycle_event(
        w.hr(w.hr_one),
        w.in_a,
        l["id"].as_str().unwrap().parse().unwrap(),
        serde_json::from_value(json!({"reason_code":"INPUT_ERROR","confirm_cascades":true}))
            .unwrap(),
    )
    .await
    .unwrap();
    let c = report(&w, w.in_a, Some("ADVISED_RESIGNATION_FAULT"), "2026-10-10")
        .await
        .unwrap();
    assert!(c["protected_periods"].as_array().unwrap().is_empty());
    let id = c["id"].as_str().unwrap().parse().unwrap();
    w.hr.close_exit_case(
        w.hr(w.hr_one),
        id,
        serde_json::from_value(json!({"reason":"합성 취소"})).unwrap(),
        "CANCELLED",
    )
    .await
    .unwrap();
    leave(&w, w.in_a, "MATERNITY", "2026-10-09", Some("2027-01-01")).await;
    assert_eq!(
        report(&w, w.in_a, Some("ADVISED_RESIGNATION_FAULT"), "2026-10-10")
            .await
            .unwrap_err()
            .code,
        "exit_protected_period"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_reason_flags_guard_and_default_to_voluntary(pool: PgPool) {
    let w = live(&pool).await;
    let mut codes = Vec::new();
    for flagged in [false, true] {
        let code = format!("T_{:X}", Uuid::new_v4().simple());
        if flagged {
            sqlx::query("INSERT INTO reason_codes (org_id,domain,code,label_ko,requires_note,created_by,involuntary,notice_required) VALUES ($1,'exit_reason',$2,$2,false,$3,true,true)").bind(w.org).bind(&code).bind(w.hr_one).execute(&pool).await.unwrap();
        } else {
            sqlx::query("INSERT INTO reason_codes (org_id,domain,code,label_ko,requires_note,created_by) VALUES ($1,'exit_reason',$2,$2,false,$3)").bind(w.org).bind(&code).bind(w.hr_one).execute(&pool).await.unwrap();
        }
        codes.push(code);
    }
    let mut tx = pool.begin().await.unwrap();
    for (i, code) in codes.iter().enumerate() {
        let class = validate_reason_in_tx(
            tx.as_mut(),
            OrgId::from_uuid(w.org),
            ReasonDomain::ExitReason,
            code,
            None,
        )
        .await
        .unwrap();
        assert_eq!((class.involuntary, class.notice_required), (i == 1, i == 1));
    }
    tx.rollback().await.unwrap();
    leave(&w, w.in_a, "WORK_INJURY", "2026-10-09", None).await;
    assert_eq!(
        report(&w, w.in_a, Some(&codes[1]), "2026-10-10")
            .await
            .unwrap_err()
            .code,
        "exit_protected_period"
    );
    let c = report(&w, w.in_b, Some(&codes[1]), "2026-10-10")
        .await
        .unwrap();
    assert_eq!(
        confirm(&w, &c, json!({})).await.unwrap_err().code,
        "notice_evidence_missing"
    );
    let bad = sqlx::query("UPDATE reason_codes SET involuntary=false WHERE org_id=$1 AND code=$2")
        .bind(w.org)
        .bind(&codes[1])
        .execute(&pool)
        .await;
    assert!(bad.is_err());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cancelling_a_voluntary_exit_does_not_end_the_restored_protected_leave(pool: PgPool) {
    let w = live(&pool).await;
    leave(&w, w.in_a, "WORK_INJURY", "2026-10-09", None).await;
    let c = report(&w, w.in_a, Some("PERSONAL"), "2026-10-10")
        .await
        .unwrap();
    confirm(&w, &c, json!({})).await.unwrap();
    w.hr.close_exit_case(
        w.hr(w.hr_one),
        c["id"].as_str().unwrap().parse().unwrap(),
        serde_json::from_value(json!({"reason":"합성 취소"})).unwrap(),
        "CANCELLED",
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT employment_status FROM employees WHERE id=$1")
            .bind(w.in_a)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "ON_LEAVE"
    );
    let e = report(&w, w.in_a, Some("ADVISED_RESIGNATION_FAULT"), "2026-11-20")
        .await
        .unwrap_err();
    assert_eq!(e.code, "exit_protected_period");
    assert!(e.refusals.unwrap()[0]["protected_until"].is_null());
}
