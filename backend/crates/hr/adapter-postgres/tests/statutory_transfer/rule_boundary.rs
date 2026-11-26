// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn transfer_loss_uses_departure_day_and_its_offset_at_rule_boundaries(pool: PgPool) {
    use serde_json::{Value, json};
    use time::{Duration, macros::date};

    let w = world(&pool).await;
    let code = console_compliance_domain::statutory::codes::resolve("ins.deadline.lose.nhis");
    let template: Value = sqlx::query_scalar("SELECT to_jsonb(r) FROM statutory_rules r WHERE code=$1 ORDER BY effective_from DESC LIMIT 1")
        .bind(code).fetch_one(&pool).await.unwrap();
    sqlx::query("DELETE FROM statutory_rules WHERE code=$1")
        .bind(code)
        .execute(&pool)
        .await
        .unwrap();

    let start = date!(2026 - 10 - 01);
    let end = start + Duration::days(1);
    // Only the middle period triggers a departing-employer filing. The first period advances
    // the loss date by a day, while the middle period uses the exit day itself.
    for (from, until, offset, triggered) in [
        (date!(2026 - 09 - 01), Some(start), 1, false),
        (start, Some(end), 0, true),
        (end, None, 1, false),
    ] {
        let mut version = template.clone();
        version["effective_from"] = json!(from.to_string());
        version["effective_to_exclusive"] = json!(until.map(|date| date.to_string()));
        version["enforced_on"] = json!(from.to_string());
        version["filing_rule"]["effective_from"] = version["effective_from"].clone();
        version["filing_rule"]["effective_to_exclusive"] =
            version["effective_to_exclusive"].clone();
        version["filing_rule"]["citation"]["enforced_on"] = version["enforced_on"].clone();
        version["filing_rule"]["loss_offset_days"] = json!(offset);
        version["trigger_event_kinds"] = if triggered {
            json!(["GROUP_TRANSFER"])
        } else {
            json!(["TERMINATE"])
        };
        version["requires_workplace_change"] = json!(false);
        sqlx::query("INSERT INTO statutory_rules SELECT (jsonb_populate_record(NULL::statutory_rules,$1)).*")
            .bind(version).execute(&pool).await.unwrap();
    }

    let rules = register_rules(&pool).await;
    for (transfer, expected) in [
        (start - Duration::days(1), false),
        (start, true),
        (end, true),
        (end + Duration::days(1), false),
    ] {
        // Keep this event as the tenant's only source, so both register prefilters see the
        // narrowest possible date range for every request.
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL session_replication_role = replica")
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("UPDATE employee_lifecycle_events SET event_type='GROUP_TRANSFER', effective_date=$2 WHERE id=$1")
            .bind(w.event).bind(transfer.to_string()).execute(tx.as_mut()).await.unwrap();
        tx.commit().await.unwrap();
        let tasks = w
            .tenant
            .hr
            .insurance_filings(
                principal(w.tenant.org, w.user),
                FilingQuery {
                    event_id: Some(w.event),
                    insurer: Some("NHIS".into()),
                    kind: Some("LOSE".into()),
                    ..list()
                },
                rules.clone(),
            )
            .await
            .unwrap();
        assert_eq!(
            tasks.items.len(),
            usize::from(expected),
            "transfer on {transfer}"
        );
        if let Some(task) = tasks.items.first() {
            assert_eq!(
                task.effective_date,
                (transfer - Duration::days(1)).to_string()
            );
            assert_eq!(
                task.basis.as_ref().unwrap().effective_from,
                start.to_string()
            );
        }
    }
}
