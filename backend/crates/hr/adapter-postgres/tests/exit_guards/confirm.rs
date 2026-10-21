// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_reason_is_not_a_voluntary_bypass(pool: PgPool) {
    let w = live(&pool).await;
    let c = report(&w, w.in_a, None, "2026-10-10").await.unwrap();
    let e = confirm(&w, &c, json!({})).await.unwrap_err();
    assert_eq!((e.status.as_u16(), e.code), (422, "exit_reason_required"));
    assert_eq!(count(&pool, "employee_lifecycle_events", &w).await, 0);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM employee_exit_cases WHERE id=$1")
            .bind(c["id"].as_str().unwrap().parse::<Uuid>().unwrap())
            .fetch_one(&pool)
            .await
            .unwrap(),
        "REPORTED"
    );
    let out = confirm(&w, &c, json!({"exit_reason_code":"PERSONAL"}))
        .await
        .unwrap();
    assert_eq!(out["exit_reason_code"], "PERSONAL");
    let e = confirm(
        &w,
        &out,
        json!({"exit_reason_code":"DISCIPLINARY_DISMISSAL"}),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, "invalid_transition");
    let e = confirm(
        &w,
        &out,
        json!({"hq_confirmation":true,"exit_reason_code":"PERSONAL"}),
    )
    .await
    .unwrap_err();
    assert_eq!((e.status.as_u16(), e.code), (422, "validation"));
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn written_notice_gates_effect_and_is_stored_and_audited(pool: PgPool) {
    let w = live(&pool).await;
    let c = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), "2026-10-10")
        .await
        .unwrap();
    let e = confirm(&w, &c, json!({})).await.unwrap_err();
    assert_eq!(
        (e.status.as_u16(), e.code),
        (422, "notice_evidence_missing")
    );
    assert_eq!(
        e.refusals.unwrap()[0]["missing"],
        json!(["reason_text", "served_on", "method", "evidence_ref"])
    );
    let mut n = notice("2026-10-11");
    n["evidence_ref"] = json!(" ");
    let e = confirm(&w, &c, json!({"dismissal_notice":n}))
        .await
        .unwrap_err();
    assert_eq!(e.refusals.unwrap()[0]["missing"], json!(["evidence_ref"]));
    let e = confirm(&w, &c, json!({"dismissal_notice":notice("2026-10-12")}))
        .await
        .unwrap_err();
    assert_eq!(e.refusals.unwrap()[0]["missing"], json!(["served_on"]));
    assert_eq!(count(&pool, "employee_lifecycle_events", &w).await, 0);
    let out = confirm(&w, &c, json!({"dismissal_notice":notice("2026-10-11")}))
        .await
        .unwrap();
    assert_eq!(out["dismissal_notice"], notice("2026-10-11"));
    assert_eq!(out["involuntary"], true);
    assert_eq!(out["notice_required"], true);
    let audit: Value = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='employee.exit.confirm'",
    )
    .bind(w.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit["involuntary"], true);
    assert_eq!(audit["dismissal_notice"], out["dismissal_notice"]);
}
