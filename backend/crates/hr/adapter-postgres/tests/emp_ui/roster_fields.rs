// SPDX-License-Identifier: LicenseRef-Proprietary
//! Fields a tenant adds to its personnel card: definitions through Cedar
//! `roster_field_manage`, their shape rules, and the active limit.

use console_hr_adapter_postgres::roster_field::{
    ACTIVE_LIMIT, CreateRosterFieldRequest, RosterFieldView, UpdateRosterFieldRequest,
};
use console_kernel_core::BranchScope;
use console_platform_authz::{Feature, Principal};
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::{Fixture, fixture, one_branch, status};

fn body(v: Value) -> CreateRosterFieldRequest {
    serde_json::from_value(v).unwrap()
}

fn change(v: Value) -> UpdateRosterFieldRequest {
    serde_json::from_value(v).unwrap()
}

async fn add(
    f: &Fixture,
    who: &Principal,
    v: Value,
) -> Result<RosterFieldView, (u16, &'static str)> {
    f.hr.create_roster_field(who.clone(), body(v))
        .await
        .map_err(|e| status(&e))
}

fn text(label: &str) -> Value {
    json!({"label": label, "value_type": "TEXT", "section": "PERSONAL"})
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_tenant_wide_definer_adds_fields_and_a_scoped_grant_does_not(pool: PgPool) {
    let f = fixture(pool, true).await;
    let definer = f
        .granted(Feature::RosterFieldManage, BranchScope::All)
        .await;
    let hr_manager = f
        .granted(Feature::EmployeeDirectoryManage, BranchScope::All)
        .await;
    assert!(add(&f, &f.ops, text("차량 번호")).await.is_ok());
    assert!(add(&f, &definer, text("사물함 번호")).await.is_ok());
    assert!(add(&f, &hr_manager, json!({"label": "통근 방법", "value_type": "CHOICE", "section": "JOB", "choices": [{"label": "버스"}, {"label": "자가"}]})).await.is_ok());
    let scoped = f.granted(Feature::RosterFieldManage, one_branch()).await;
    let scoped_hr = f
        .granted(Feature::EmployeeDirectoryManage, one_branch())
        .await;
    let reader = f
        .granted(Feature::EmployeeDirectoryRead, BranchScope::All)
        .await;
    for who in [&scoped, &scoped_hr, &reader] {
        assert_eq!(
            add(&f, who, text("작업복 치수")).await.unwrap_err(),
            (403, "forbidden")
        );
    }
    assert_eq!(f.count("roster_field_definitions").await, 3);
    assert_eq!(f.audits("roster_field.create").await, 3);
    // A reader sees the definitions (the card draws from them) but may not change them.
    let seen = f.hr.roster_fields(reader.clone()).await.unwrap();
    assert!(!seen.can_manage);
    assert_eq!(seen.active_limit, ACTIVE_LIMIT);
    assert_eq!(
        seen.items
            .iter()
            .map(|i| i.label.as_str())
            .collect::<Vec<_>>(),
        ["차량 번호", "사물함 번호", "통근 방법"]
    );
    assert!(
        seen.items
            .iter()
            .all(|i| i.visibility == "MANAGERS" && i.active)
    );
    let refused =
        f.hr.update_roster_field(reader, seen.items[0].id, change(json!({"active": false})))
            .await
            .unwrap_err();
    assert_eq!(status(&refused), (403, "forbidden"));
    assert!(f.hr.roster_fields(f.ops.clone()).await.unwrap().can_manage);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bad_definitions_are_refused_with_their_codes(pool: PgPool) {
    let f = fixture(pool, true).await;
    for (v, code) in [
        (text(" "), (422, "roster_field_label_invalid")),
        (text(&"가".repeat(61)), (422, "roster_field_label_invalid")),
        (text("\u{200B}"), (422, "roster_field_label_invalid")),
        (text("Locker\u{200B}"), (422, "roster_field_label_invalid")),
        (
            json!({"label": "a", "value_type": "TEXT", "section": "PERSONAL", "choices": [{"label": "x"}]}),
            (422, "roster_field_choices_invalid"),
        ),
        (
            json!({"label": "a", "value_type": "CHOICE", "section": "PERSONAL"}),
            (422, "roster_field_choices_invalid"),
        ),
    ] {
        assert_eq!(add(&f, &f.ops, v).await.unwrap_err(), code);
    }
    // Unknown types and sections (a pay section among them) never reach the store.
    for v in [
        json!({"label": "a", "value_type": "MONEY", "section": "PERSONAL"}),
        json!({"label": "a", "value_type": "TEXT", "section": "PAY"}),
        json!({"label": "a", "value_type": "TEXT", "section": "PERSONAL", "visibility": "SELF"}),
    ] {
        assert!(serde_json::from_value::<CreateRosterFieldRequest>(v).is_err());
    }
    assert_eq!(f.count("roster_field_definitions").await, 0);
    // A label is unique per tenant ignoring case, retired fields included.
    let first = add(&f, &f.ops, text("Locker")).await.unwrap();
    f.hr.update_roster_field(f.ops.clone(), first.id, change(json!({"active": false})))
        .await
        .unwrap();
    assert_eq!(
        add(&f, &f.ops, text("locker")).await.unwrap_err(),
        (409, "roster_field_label_taken")
    );
    assert_eq!(f.audits("roster_field.create").await, 1);
    // A rename into another field's label is refused the same way.
    let second = add(&f, &f.ops, text("사물함")).await.unwrap();
    let renamed =
        f.hr.update_roster_field(f.ops.clone(), second.id, change(json!({"label": "LOCKER"})));
    assert_eq!(
        renamed.await.map_err(|e| status(&e)).unwrap_err(),
        (409, "roster_field_label_taken")
    );
    // A change that changes nothing writes no event.
    let before = f.audits("roster_field.update").await;
    f.hr.update_roster_field(f.ops.clone(), second.id, change(json!({})))
        .await
        .unwrap();
    f.hr.update_roster_field(
        f.ops.clone(),
        second.id,
        change(json!({"label": "사물함", "active": true})),
    )
    .await
    .unwrap();
    assert_eq!(f.audits("roster_field.update").await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_change_relabels_and_retires_but_never_moves_type_or_section(pool: PgPool) {
    let f = fixture(pool, true).await;
    let field = add(&f, &f.ops, json!({"label": "숙소", "value_type": "CHOICE", "section": "JOB", "choices": [{"label": "기숙사"}, {"label": "통근"}]})).await.unwrap();
    let (dorm, commute) = (field.choices[0].id, field.choices[1].id);
    let changed = f.hr.update_roster_field(f.ops.clone(), field.id, change(json!({
        "label": "거주 형태",
        "choices": [{"id": dorm, "label": "사내 기숙사"}, {"id": commute, "label": "통근"}, {"label": "자가"}],
    }))).await.unwrap();
    assert_eq!(changed.label, "거주 형태");
    assert_eq!(
        (changed.choices[0].id, changed.choices[0].label.as_str()),
        (dorm, "사내 기숙사")
    );
    assert_eq!(changed.choices.len(), 3);
    assert_eq!(
        (changed.value_type.as_str(), changed.section.as_str()),
        ("CHOICE", "JOB")
    );
    // Dropping an option is refused; type and section are not part of a change.
    let dropped =
        f.hr.update_roster_field(
            f.ops.clone(),
            field.id,
            change(json!({"choices": [{"id": dorm, "label": "기숙사"}]})),
        )
        .await
        .unwrap_err();
    assert_eq!(status(&dropped), (422, "roster_field_choices_invalid"));
    assert!(
        serde_json::from_value::<UpdateRosterFieldRequest>(json!({"value_type": "TEXT"})).is_err()
    );
    assert!(
        serde_json::from_value::<UpdateRosterFieldRequest>(json!({"section": "PERSONAL"})).is_err()
    );
    let retired =
        f.hr.update_roster_field(f.ops.clone(), field.id, change(json!({"active": false})))
            .await
            .unwrap();
    assert!(!retired.active);
    assert_eq!(retired.choices, changed.choices);
    let missing =
        f.hr.update_roster_field(
            f.ops.clone(),
            uuid::Uuid::new_v4(),
            change(json!({"active": false})),
        )
        .await
        .unwrap_err();
    assert_eq!(status(&missing), (404, "roster_field_not_found"));
    assert_eq!(f.audits("roster_field.update").await, 2);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_active_limit_holds_when_two_adds_race(pool: PgPool) {
    let f = fixture(pool, true).await;
    let mut first = None;
    for i in 1..ACTIVE_LIMIT {
        let field = add(&f, &f.ops, text(&format!("항목 {i}"))).await.unwrap();
        first.get_or_insert(field.id);
    }
    let (a, b) = tokio::join!(
        f.hr.create_roster_field(f.ops.clone(), body(text("마지막 A"))),
        f.hr.create_roster_field(f.ops.clone(), body(text("마지막 B"))),
    );
    let refused: Vec<_> = [a, b]
        .into_iter()
        .filter_map(Result::err)
        .map(|e| status(&e))
        .collect();
    assert_eq!(refused, [(409, "roster_field_limit")]);
    assert_eq!(f.count("roster_field_definitions").await, ACTIVE_LIMIT);
    // Retiring frees a place; restoring when full is refused like an add.
    let first = first.unwrap();
    f.hr.update_roster_field(f.ops.clone(), first, change(json!({"active": false})))
        .await
        .unwrap();
    add(&f, &f.ops, text("대신 들어온 항목")).await.unwrap();
    let restore =
        f.hr.update_roster_field(f.ops.clone(), first, change(json!({"active": true})))
            .await
            .unwrap_err();
    assert_eq!(status(&restore), (409, "roster_field_limit"));
}
