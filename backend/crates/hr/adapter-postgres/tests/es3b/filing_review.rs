// SPDX-License-Identifier: LicenseRef-Proprietary
//! Drafts remain visible without trapping a case; released rules use the normal receipt path.
use super::*;
use console_hr_adapter_postgres::statutory::FilingQuery;
#[path = "../support/lifecycle_attest.rs"]
mod attest;

async fn register(f: &Fixture) -> console_compliance_domain::statutory::StatutoryRegister {
    console_platform_db::statutory_read::load_statutory_register(
        &mut f.owner.acquire().await.unwrap(),
    )
    .await
    .unwrap()
}

async fn moved(f: &Fixture) -> Uuid {
    let (entity, w) = f.entity(2).await;
    f.place(entity, w[0]).await;
    let value = f
        .record(event("TRANSFER", &day(0), json!({"to_workplace_id":w[1]})))
        .await
        .unwrap();
    Uuid::parse_str(value["id"].as_str().unwrap()).unwrap()
}

async fn appointment(
    f: &Fixture,
    event: Uuid,
) -> console_hr_adapter_postgres::cases::LifecycleCase {
    f.hr.employee_lifecycle_cases(f.principal.clone(), f.employee)
        .await
        .unwrap()
        .into_iter()
        .find(|case| case.trigger_id == Some(event))
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn draft_change_filings_refuse_every_record_action_and_do_not_block_close(pool: PgPool) {
    let f = fixture(pool, true).await;
    let event = moved(&f).await;
    let case = appointment(&f, event).await;
    let preview =
        f.hr.lifecycle_template_preview_for(
            f.principal.clone(),
            "TRANSFER".to_owned(),
            console_hr_adapter_postgres::cases::TemplatePreviewQuery {
                variant: Some("WORKPLACE_CHANGE".to_owned()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        preview
            .iter()
            .map(|i| &i.item_key)
            .collect::<std::collections::BTreeSet<_>>(),
        case.items.iter().map(|i| &i.item_key).collect()
    );
    let change: Vec<_> = preview
        .iter()
        .filter(|i| i.filing_kind.as_deref() == Some("CHANGE"))
        .collect();
    assert_eq!(change.len(), 4);
    assert!(change.iter().all(|i| i.legal_review_required));
    let register = register(&f).await;
    let filings =
        f.hr.insurance_filings(
            f.principal.clone(),
            FilingQuery {
                event_id: Some(event),
                ..Default::default()
            },
            register.clone(),
        )
        .await
        .unwrap()
        .items;
    assert!(!filings.is_empty());
    for filing in filings {
        assert_eq!(filing.kind, "CHANGE");
        assert_eq!(filing.state, "LEGAL_REVIEW");
        let item = case
            .items
            .iter()
            .find(|item| item.filing_obligation_id == filing.filing_obligation_id)
            .unwrap();
        assert!(!item.blocks_close);
        assert_eq!(item.status_code.as_deref(), Some("LEGAL_REVIEW"));
        for body in [
            json!({"expected_version":0,"action":"COMPLETE","completed_on":day(0)}),
            json!({"expected_version":0,"action":"NOT_APPLICABLE","not_applicable_reason":"OTHER_LEGAL_GROUND","detail":"검토 전"}),
            json!({"expected_version":0,"action":"ASSESS","applicability_facts":{}}),
        ] {
            let error =
                f.hr.record_insurance_filing(
                    f.principal.clone(),
                    (event, filing.kind.clone(), filing.insurer.clone()),
                    Uuid::new_v4().to_string(),
                    serde_json::from_value(body).unwrap(),
                    register.clone(),
                )
                .await
                .unwrap_err();
            assert_eq!(error.status.as_u16(), 422);
            assert_eq!(error.code, "filing_rule_unverified");
        }
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM insurance_filing_records WHERE event_id=$1")
            .bind(event)
            .fetch_one(&f.owner)
            .await
            .unwrap();
    assert_eq!(count, 0);
    attest::document(&f.owner, &f.hr, &f.principal, &case).await;
    assert_eq!(
        f.hr.close_lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap()
            .state,
        "CLOSED"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn released_change_filings_record_each_receipt_and_close_the_same_case(pool: PgPool) {
    let f = fixture(pool, true).await;
    let event = moved(&f).await;
    // Synthetic review changes only the fixture, never the shipped legal interpretation.
    sqlx::query("UPDATE statutory_filing_drafts SET release_disposition='RELEASED',review_receipt_ref='synthetic-review',filing_rule=jsonb_set(filing_rule,'{applicability_unverified}','false')")
        .execute(&f.owner).await.unwrap();
    let case = appointment(&f, event).await;
    let items: Vec<_> = case
        .items
        .iter()
        .filter(|item| item.kind == "FIL")
        .collect();
    assert!(!items.is_empty());
    assert!(items.iter().all(|item| item.blocks_close));
    let preview =
        f.hr.lifecycle_template_preview_for(
            f.principal.clone(),
            "TRANSFER".to_owned(),
            console_hr_adapter_postgres::cases::TemplatePreviewQuery {
                variant: Some("WORKPLACE_CHANGE".to_owned()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        preview
            .iter()
            .filter(|i| i.kind == "FIL")
            .all(|i| !i.legal_review_required)
    );
    attest::document(&f.owner, &f.hr, &f.principal, &case).await;
    assert_eq!(
        f.hr.close_lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap_err()
            .code,
        "lifecycle.refuse.close_blocked"
    );
    let register = register(&f).await;
    for item in items {
        let filing = f.hr.record_insurance_filing(f.principal.clone(),
            (event, item.filing_kind.clone().unwrap(), item.insurer.clone().unwrap()),
            Uuid::new_v4().to_string(), serde_json::from_value(json!({
                    "expected_version":0,"action":"COMPLETE","completed_on":day(0),"receipt_number":"synthetic-change-receipt"
            })).unwrap(), register.clone()).await.unwrap();
        assert_eq!(filing.state, "DONE");
        assert_eq!(filing.filing_obligation_id, item.filing_obligation_id);
    }
    let closed =
        f.hr.close_lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap();
    assert_eq!(closed.state, "CLOSED");
    for item in closed.items.iter().filter(|item| item.kind == "FIL") {
        assert_eq!(item.basis["legal_review_required"], false);
        assert_eq!(item.status, "DONE_OBSERVED");
        let receipt: Uuid =
            serde_json::from_value(item.observed_ref.as_ref().unwrap()["id"].clone()).unwrap();
        let kind: String = sqlx::query_scalar(
            "SELECT filing_kind FROM insurance_filing_records WHERE id=$1 AND event_id=$2",
        )
        .bind(receipt)
        .bind(event)
        .fetch_one(&f.owner)
        .await
        .unwrap();
        assert_eq!(kind, "CHANGE");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn appointment_with_the_same_workplace_has_no_change_filings(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (entity, w) = f.entity(1).await;
    let preview =
        f.hr.lifecycle_template_preview(f.principal.clone(), "TRANSFER".to_owned())
            .await
            .unwrap();
    assert!(
        preview
            .iter()
            .all(|i| i.filing_kind.as_deref() != Some("CHANGE"))
    );
    f.place(entity, w[0]).await;
    for workplace in [json!({}), json!({"to_workplace_id":w[0]})] {
        let unit = f.unit_at(entity, w[0]).await;
        let mut body = json!({"to_org_unit_id":unit});
        body.as_object_mut()
            .unwrap()
            .extend(workplace.as_object().unwrap().clone());
        let value = f.record(event("TRANSFER", &day(0), body)).await.unwrap();
        let event = Uuid::parse_str(value["id"].as_str().unwrap()).unwrap();
        assert!(
            appointment(&f, event)
                .await
                .items
                .iter()
                .all(|item| item.filing_kind.as_deref() != Some("CHANGE"))
        );
        let filings =
            f.hr.insurance_filings(
                f.principal.clone(),
                FilingQuery {
                    event_id: Some(event),
                    ..Default::default()
                },
                register(&f).await,
            )
            .await
            .unwrap();
        assert!(filings.items.iter().all(|filing| filing.kind != "CHANGE"));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn recording_waits_for_both_rule_release_and_applicability_verification(pool: PgPool) {
    let f = fixture(pool, true).await;
    let event = moved(&f).await;
    for (disposition, receipt, unverified) in [
        ("HOLD", None, false),
        ("RELEASED", Some("synthetic-review"), true),
    ] {
        sqlx::query("UPDATE statutory_filing_drafts SET release_disposition=$1,review_receipt_ref=$2,filing_rule=jsonb_set(filing_rule,'{applicability_unverified}',to_jsonb($3::boolean))")
            .bind(disposition).bind(receipt).bind(unverified).execute(&f.owner).await.unwrap();
        let case = appointment(&f, event).await;
        for item in case.items.iter().filter(|item| item.kind == "FIL") {
            assert_eq!(item.status_code.as_deref(), Some("LEGAL_REVIEW"));
            assert!(!item.blocks_close);
        }
        let filings =
            f.hr.insurance_filings(
                f.principal.clone(),
                FilingQuery {
                    event_id: Some(event),
                    ..Default::default()
                },
                register(&f).await,
            )
            .await
            .unwrap();
        assert!(
            filings
                .items
                .iter()
                .all(|filing| filing.state == "LEGAL_REVIEW")
        );
    }
}
