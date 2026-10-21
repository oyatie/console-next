use super::*;

pub(super) async fn assert_empty_grants(pool: &PgPool, user: UserId) {
    let empty: bool = sqlx::query_scalar(
        "SELECT NOT u.is_tenant_ops
           AND NOT EXISTS (SELECT 1 FROM access_grants g
             WHERE g.org_id=u.org_id AND g.account_id=u.id)
           AND NOT EXISTS (SELECT 1 FROM user_role_assignments a
             WHERE a.org_id=u.org_id AND a.user_id=u.id)
           AND NOT EXISTS (SELECT 1 FROM user_branches b
             WHERE b.org_id=u.org_id AND b.user_id=u.id)
         FROM users u WHERE u.id=$1",
    )
    .bind(user.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    assert!(empty, "self-read must work without grants or break-glass");
}

pub(super) async fn seed_exception(pool: &PgPool, actor: UserId, employee_id: Uuid, code: &str) {
    sqlx::query(
        "INSERT INTO attendance_exceptions (org_id, code, kind, employee_id, work_date, occurred_at, detail, idempotency_key, request_fingerprint, created_by) VALUES ($1, $2, 'LATE', $3, DATE '2026-07-20', TIMESTAMPTZ '2026-07-20 09:00:00+00', 'late', $4, $5, $6)",
    )
    .bind(*OrgId::one().as_uuid())
    .bind(code)
    .bind(employee_id)
    .bind(format!("{code}-idempotency-key"))
    .bind("a".repeat(64))
    .bind(*actor.as_uuid())
    .execute(pool)
    .await
    .unwrap();
}
