// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_scoped_assessment_keeps_the_recorded_monthly_income(pool: PgPool) {
    let w = world(&pool).await;
    let rules = register_rules(&pool).await;
    let wide = principal(w.tenant.org, w.user);
    let scoped = Principal::new(
        w.user,
        OrgId::from_uuid(w.tenant.org),
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    )
    .with_scope_grants(vec![ScopeGrant {
        feature: Feature::EmployeeDirectoryManage,
        kind: NodeKind::Workplace,
        id: w.site,
    }]);
    let facts = json!({"monthly_hours":160,"weekly_hours":40,"continuous_months":1,"daily":false,"foreign":false,"director_without_worker_status":false});
    let mut captured = facts.clone();
    captured["monthly_income_won"] = json!(2_500_000);
    let target = || (w.event, "ACQUIRE".to_owned(), "NPS".to_owned());
    let first: RecordFiling = serde_json::from_value(
        json!({"expected_version":0,"action":"ASSESS","applicability_facts":captured}),
    )
    .unwrap();
    let t = w
        .tenant
        .hr
        .record_insurance_filing(
            wide.clone(),
            target(),
            "captured".into(),
            first,
            rules.clone(),
        )
        .await
        .unwrap();
    // A holder without sensitive-facts authority sends the facts back as read: without the income.
    let again: RecordFiling = serde_json::from_value(
        json!({"expected_version":t.version,"action":"ASSESS","applicability_facts":facts}),
    )
    .unwrap();
    w.tenant
        .hr
        .record_insurance_filing(scoped, target(), "restated".into(), again, rules.clone())
        .await
        .unwrap();
    let page = w
        .tenant
        .hr
        .insurance_filings(wide, list(), rules)
        .await
        .unwrap();
    let task = page
        .items
        .iter()
        .find(|t| t.event_id == w.event && t.kind == "ACQUIRE" && t.insurer == "NPS")
        .unwrap();
    assert_eq!(task.applicability_facts.monthly_income_won, Some(2_500_000));
}
