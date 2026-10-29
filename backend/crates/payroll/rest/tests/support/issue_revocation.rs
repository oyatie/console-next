// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

/// Revoke after the first transaction, while the recipient's document is emitted.
/// A DB trigger makes the interleaving deterministic without a production hook.
pub(super) async fn assert_second_gate(
    pool: &PgPool,
    rt: &PgPool,
    keys: &Keys,
    org: OrgId,
    actor: UserId,
    run: Uuid,
    token: &str,
) {
    sqlx::raw_sql(
        "CREATE FUNCTION revoke_pay_on_payslip() RETURNS trigger
         LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
         BEGIN
           UPDATE public.access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by
           WHERE org_id=NEW.org_id AND status='ACTIVE' AND account_id=(
             SELECT submitted_by FROM public.payroll_draft_runs WHERE id=NEW.source_id::uuid);
           RETURN NEW;
         END $$;",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        "CREATE TRIGGER revoke_pay_on_payslip AFTER INSERT ON inbox_docs
         FOR EACH ROW WHEN (NEW.kind='payslip')
         EXECUTE FUNCTION revoke_pay_on_payslip()",
    )
    .execute(pool)
    .await
    .unwrap();
    let (status, denied) = send(
        rt,
        keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/issue-payslips"),
        token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{denied}");
    assert_eq!(denied["error"]["code"], "forbidden");
    let state: String = sqlx::query_scalar("SELECT status FROM payroll_draft_runs WHERE id=$1")
        .bind(run)
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(
        state, "PAID",
        "revocation must prevent the ISSUED transition"
    );
    for query in [
        "SELECT count(*) FROM payroll_payslip_deliveries WHERE run_id=$1",
        "SELECT count(*) FROM audit_events WHERE target_id=$1::text AND action='payroll_run.payslip_issue'",
    ] {
        let count: i64 = sqlx::query_scalar(query)
            .bind(run)
            .fetch_one(pool)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "refused finalization cannot write delivery links or audit"
        );
    }
    let docs: i64 =
        sqlx::query_scalar("SELECT count(*) FROM inbox_docs WHERE source_id=$1 AND kind='payslip'")
            .bind(run.to_string())
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(docs, 1, "the trigger must run between the two gates");
    sqlx::raw_sql(
        "DROP TRIGGER revoke_pay_on_payslip ON inbox_docs; DROP FUNCTION revoke_pay_on_payslip();",
    )
    .execute(pool)
    .await
    .unwrap();
    pay_view::grant_manage(pool, org, actor, None).await;
    // The caller retries with renewed authority and proves delivery is deduplicated.
}
