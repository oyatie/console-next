// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{Duration, OffsetDateTime, PgPool, UserId, Uuid};

pub(super) async fn seed_profile(
    pool: &PgPool,
    org: Uuid,
    employee: Uuid,
    actor: UserId,
    employment_type: &str,
) {
    sqlx::query(
        "INSERT INTO employee_employment_profiles \
         (employee_id, org_id, employment_type, phone_e164, base_pay, idempotency_key, request_hash, created_by) \
         VALUES ($1, $2, $3, '+821012345678', 3000000, $4, repeat('a', 64), $5)",
    )
    .bind(employee)
    .bind(org)
    .bind(employment_type)
    .bind(format!("profile-{employee}"))
    .bind(*actor.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    if employment_type == "CONTRACT" {
        let today = OffsetDateTime::now_utc().date();
        let hired = today - Duration::days(60);
        sqlx::query("UPDATE employees SET hire_date=$3 WHERE org_id=$1 AND id=$2")
            .bind(org)
            .bind(employee)
            .bind(hired.to_string())
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("UPDATE employee_employment_profiles SET contract_start_date=$3,contract_end_date=$4 WHERE org_id=$1 AND employee_id=$2")
            .bind(org).bind(employee).bind(hired).bind(today - Duration::DAY)
            .execute(pool).await.unwrap();
    }
}
