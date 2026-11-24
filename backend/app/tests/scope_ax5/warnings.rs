// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rehire_and_replay_hide_namesakes_outside_the_directory_grant(pool: PgPool) {
    let mut w = world(pool).await;
    let entity = w.le_a.clone();
    let hr = w.holder("LEGAL_ENTITY", Some(&entity)).await;
    let person = format!("/api/v1/employees/{}", w.a2);
    let (status, current) = hr.call("GET", &person, None).await;
    assert_eq!(status, StatusCode::OK, "{current}");
    let hire_date =
        (console_hr_adapter_postgres::clock::today_kst() + time::Duration::days(1)).to_string();
    let mut namesake = employee_body("B-102", &w.branch_b, &w.dept_b);
    namesake["name"] = current["employee"]["name"].clone();
    namesake["hire_date"] = json!(hire_date);
    namesake["phone"] = json!("010-2345-6789");
    let hidden = w.ok("POST", "/api/v1/employees", namesake).await;

    sqlx::query("UPDATE employees SET employment_status = 'EXITED', exit_date = hire_date WHERE id = $1::uuid")
        .bind(&w.a2).execute(&w.pool).await.unwrap();
    let rehire = json!({
        "hire_date": hire_date, "employment_type": "REGULAR", "org_unit_id": w.dept_y,
        "position": "사원", "idempotency_key": Uuid::new_v4()
    });
    for expected in [StatusCode::CREATED, StatusCode::OK] {
        let (status, detail) = hr
            .call("POST", &format!("{person}/rehire"), Some(rehire.clone()))
            .await;
        assert_eq!(status, expected, "{detail}");
        assert!(
            detail["warnings"]
                .as_array()
                .into_iter()
                .flatten()
                .all(|w| w["code"] != "same_name_same_hire_date"),
            "{detail}"
        );
    }
    let (status, visible) = w.ops.call("GET", &person, None).await;
    assert_eq!(status, StatusCode::OK, "{visible}");
    assert_eq!(
        visible["warnings"][0]["matches"][0]["id"],
        hidden["employee"]["id"]
    );
}
