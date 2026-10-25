// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn final_exit_stages_require_an_explicit_acknowledgement(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    for status in [
        "HQ_CONFIRMED",
        "SETTLEMENT_READY",
        "APPROVAL_DRAFTED",
        "SUBMITTED",
    ] {
        let id = exited(&f, &pool, status).await;
        sqlx::query("INSERT INTO employee_exit_cases (org_id,employee_id,status,effective_exit_date,site_manager_note,reported_by) VALUES ($1,$2,$3,$4::date,'합성 퇴직',$5)")
            .bind(f.principal.org_id.as_uuid()).bind(id).bind(status).bind(kst_day(-10)).bind(f.principal.user_id.as_uuid()).execute(&pool).await.unwrap();
        let error =
            f.hr.rehire_employee(
                f.principal.clone(),
                id,
                rehire(&f, &format!("{status}-refused"), kst_day(0)),
            )
            .await
            .unwrap_err();
        assert_eq!(
            (error.status.as_u16(), error.code),
            (409, "rehire_exit_case_open")
        );
        let facts = error.refusals.unwrap();
        assert_eq!(facts[0]["decision_final"], true);
        assert_eq!(facts[0]["acknowledgement_required"], true);
        assert!(!facts[0]["open_legs"].as_array().unwrap().is_empty());
        let mut body = rehire(&f, &format!("{status}-acknowledged"), kst_day(0));
        body.acknowledge_open_exit_case = true;
        f.hr.rehire_employee(f.principal.clone(), id, body)
            .await
            .unwrap();
    }
}
