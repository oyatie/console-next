// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use time::OffsetDateTime;
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn access_end_follows_the_reason_class(pool: PgPool) {
    let w = live(&pool).await;
    let today = (OffsetDateTime::now_utc() + Duration::hours(9)).date();
    let on = today + Duration::days(20);
    for (employee, reason, involuntary) in [
        (w.in_a, "ADVISED_RESIGNATION_FAULT", true),
        (w.in_b, "PERSONAL", false),
    ] {
        let user = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id,display_name,roles,org_id,employee_id) VALUES ($1,'합성','{}',$2,$3)").bind(user).bind(w.org).bind(employee).execute(&pool).await.unwrap();
        let role: Uuid=sqlx::query_scalar("INSERT INTO access_roles (org_id,name_ko,status,version,created_by) VALUES ($1,$2,'ACTIVE',1,$3) RETURNING id").bind(w.org).bind(Uuid::new_v4().to_string()).bind(w.hr_one).fetch_one(&pool).await.unwrap();
        sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,valid_to,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',now()+interval '1 year','OPERATING','NEW_HIRE',$4)").bind(w.org).bind(user).bind(role).bind(w.hr_one).execute(&pool).await.unwrap();
        let c = report(&w, employee, Some(reason), &on.to_string())
            .await
            .unwrap();
        confirm(&w, &c, json!({})).await.unwrap();
        let ended: bool = sqlx::query_scalar(
            "SELECT valid_to <= now() FROM access_grants WHERE org_id=$1 AND account_id=$2",
        )
        .bind(w.org)
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(ended, involuntary);
    }
}
