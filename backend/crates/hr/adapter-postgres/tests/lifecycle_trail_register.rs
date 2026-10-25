// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Register triggers preserve the released mapping and owning-place calendar.

#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;

use std::collections::BTreeSet;

use console_compliance_domain::statutory::StatutoryRegister;
use console_hr_adapter_postgres::clock::today_kst;
use console_hr_adapter_postgres::statutory::FilingQuery;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime, Time};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn n_minus_one_core_register_never_receives_the_new_draft_vocabulary(pool: PgPool) {
    let core: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM statutory_rules WHERE filing_rule->>'filing_kind'='CHANGE'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        core, 0,
        "N-1 readers still query the core register and must not see unknown codes"
    );
    let rows:Vec<(String,Option<String>)>=sqlx::query_as("SELECT code,filing_rule->'deadline'->>'kind' FROM lifecycle_statutory_rules WHERE filing_rule->>'filing_kind'='CHANGE'")
        .fetch_all(&pool).await.unwrap();
    assert!(!rows.is_empty());
    assert!(
        rows.iter()
            .all(|(_, kind)| kind.as_deref() == Some("UNKNOWN"))
    );
    let rules = register(&pool).await;
    for code in rows
        .into_iter()
        .map(|(code, _)| code)
        .collect::<BTreeSet<_>>()
    {
        assert!(
            rules
                .filing_rule_by_code(&code, today_kst())
                .unwrap()
                .is_some()
        );
    }
}

async fn register(pool: &PgPool) -> StatutoryRegister {
    console_compliance_adapter_postgres::PgComplianceStore::new(pool.clone())
        .statutory_register()
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_trigger_rows_preserve_legacy_four_scheme_mapping_and_n_minus_one_json(
    pool: PgPool,
) {
    let on = today_kst();
    let rows: Vec<(String, String, Vec<String>)> = sqlx::query_as(
        "SELECT filing_rule->>'filing_kind',filing_rule->>'insurer', \
           ARRAY(SELECT unnest(trigger_event_kinds) ORDER BY 1) FROM statutory_rules \
         WHERE filing_rule IS NOT NULL AND effective_from<=$1 \
           AND (effective_to_exclusive IS NULL OR $1<effective_to_exclusive) \
           AND filing_rule->>'filing_kind' IN ('ACQUIRE','AGE60','LOSE','LEAVE','RESUME')",
    )
    .bind(on)
    .fetch_all(&pool)
    .await
    .unwrap();
    let mut expected = BTreeSet::new();
    for (kind, events) in [
        ("ACQUIRE", vec!["GROUP_TRANSFER", "ONBOARD", "REHIRE"]),
        ("AGE60", vec!["GROUP_TRANSFER", "ONBOARD", "REHIRE"]),
        ("LOSE", vec!["GROUP_TRANSFER", "OFFBOARD", "TERMINATE"]),
        ("LEAVE", vec!["LEAVE_OF_ABSENCE"]),
        ("RESUME", vec!["RETURN_FROM_LEAVE"]),
    ] {
        for insurer in ["NPS", "NHIS", "EI", "IACI"] {
            if kind == "AGE60" && insurer != "NPS" {
                continue;
            }
            expected.insert((
                kind.to_owned(),
                insurer.to_owned(),
                events
                    .iter()
                    .map(|event| (*event).to_owned())
                    .collect::<Vec<_>>(),
            ));
        }
    }
    assert_eq!(rows.into_iter().collect::<BTreeSet<_>>(), expected);
    let incompatible: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM statutory_rules WHERE filing_rule ? 'trigger_event_kinds'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(incompatible, 0, "N-1 FilingRule uses deny_unknown_fields");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn changing_a_register_trigger_removes_its_filing_without_a_code_change(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let on = today_kst();
    let mut body = f.body("lifecycle-trigger-test", "REGULAR");
    body.hire_date = Some(on.to_string());
    let employee = f.create(body).await.unwrap().employee_id();
    let case =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap()
            .remove(0);
    let query = || FilingQuery {
        event_id: case.trigger_id,
        insurer: Some("NHIS".into()),
        kind: Some("ACQUIRE".into()),
        ..Default::default()
    };
    let before =
        f.hr.insurance_filings(f.principal.clone(), query(), register(&pool).await)
            .await
            .unwrap();
    assert_eq!(before.items.len(), 1);
    sqlx::query("UPDATE statutory_rules SET trigger_event_kinds=array_remove(trigger_event_kinds,'ONBOARD') \
        WHERE code='ins.deadline.acquire.nhis' AND effective_from<=$1 AND (effective_to_exclusive IS NULL OR $1<effective_to_exclusive)")
        .bind(on).execute(&pool).await.unwrap();
    let after =
        f.hr.insurance_filings(f.principal.clone(), query(), register(&pool).await)
            .await
            .unwrap();
    assert!(after.items.is_empty());
    let changed =
        f.hr.lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap();
    let item = changed
        .items
        .iter()
        .find(|item| item.due_rule_ref.as_deref() == Some("ins.deadline.acquire.nhis"))
        .unwrap();
    assert_eq!(
        item.status, "NOT_APPLICABLE",
        "the case consumes the same registered trigger as the statutory list"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplace_entity_and_pack_zones_control_filing_and_case_day_counts(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let on = today_kst();
    let mut body = f.body("lifecycle-zone-test", "REGULAR");
    body.hire_date = Some(on.to_string());
    let employee = f.create(body).await.unwrap().employee_id();
    let (org, entity, workplace) = (
        *f.principal.org_id.as_uuid(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
        .bind(org).bind(entity).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO workplaces (org_id,id,legal_entity_id,needs_confirmation,created_change_mode) VALUES ($1,$2,$3,true,'MIGRATION')")
        .bind(org).bind(workplace).bind(entity).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) \
        VALUES ($1,$2,$3,$4,$5,'MIGRATION',gen_random_uuid())")
        .bind(org).bind(employee).bind(entity).bind(workplace).bind(on).execute(tx.as_mut()).await.unwrap();
    sqlx::query("UPDATE lifecycle_cases SET legal_entity_id=$3,workplace_id=$4 WHERE org_id=$1 AND employee_id=$2")
        .bind(org).bind(employee).bind(entity).bind(workplace).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let case =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap()
            .remove(0);
    let as_of = (OffsetDateTime::now_utc().date() + Duration::days(1))
        .with_time(Time::from_hms(0, 30, 0).unwrap())
        .assume_utc();
    let mut counts = Vec::new();
    for (site_zone, entity_zone, pack_zone, local_date) in [
        (
            Some("Pacific/Honolulu"),
            Some("Pacific/Kiritimati"),
            "UTC",
            as_of.date() - Duration::days(1),
        ),
        (None, Some("Pacific/Kiritimati"), "UTC", as_of.date()),
        (
            None,
            None,
            "Pacific/Honolulu",
            as_of.date() - Duration::days(1),
        ),
    ] {
        sqlx::query("UPDATE workplaces SET time_zone=$3 WHERE org_id=$1 AND id=$2")
            .bind(org)
            .bind(workplace)
            .bind(site_zone)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE legal_entities SET time_zone=$3 WHERE org_id=$1 AND id=$2")
            .bind(org)
            .bind(entity)
            .bind(entity_zone)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE lifecycle_country_packs SET time_zone=$1 WHERE is_default")
            .bind(pack_zone)
            .execute(&pool)
            .await
            .unwrap();
        let page =
            f.hr.insurance_filings(
                f.principal.clone(),
                FilingQuery {
                    event_id: case.trigger_id,
                    insurer: Some("NHIS".into()),
                    kind: Some("ACQUIRE".into()),
                    inbox_as_of: Some(as_of),
                    ..Default::default()
                },
                register(&pool).await,
            )
            .await
            .unwrap();
        let filing = page.items.into_iter().next().unwrap();
        let due =
            console_hr_domain::text::parse_yyyy_mm_dd(filing.due_date.as_deref().unwrap()).unwrap();
        assert_eq!(filing.due_in_days, Some((due - local_date).whole_days()));
        let current =
            f.hr.lifecycle_case(f.principal.clone(), case.id)
                .await
                .unwrap();
        let item = current
            .items
            .iter()
            .find(|item| item.due_rule_ref.as_deref() == Some("ins.deadline.acquire.nhis"))
            .unwrap();
        assert_eq!(item.due_date, filing.due_date);
        counts.push((filing.due_in_days.unwrap(), item.due_in_days.unwrap()));
    }
    assert_eq!(counts[0].0, counts[1].0 + 1);
    assert_eq!(counts[0].1, counts[1].1 + 1);
    assert_eq!(counts[0], counts[2]);
}
