//! Resolution order, change rules and the snapshot shape.
#![allow(clippy::unwrap_used, clippy::panic)]

use console_kernel_core::{KernelError, SettingVersionId};
use console_settings_domain::{
    Direction, OverrideRow, SettingError, SettingKey as K, SettingValue as V, SettingsSnapshot,
    check_change, resolve,
};
use serde_json::json;
use time::macros::datetime;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

const NOW: OffsetDateTime = datetime!(2026-10-02 09:00 UTC);

fn row(n: u128, entity: Option<Uuid>, days: i64, value: V) -> OverrideRow {
    OverrideRow {
        id: Uuid::from_u128(n),
        scope_entity_id: entity,
        value,
        effective_from: NOW + Duration::days(days),
    }
}

#[test]
fn no_row_resolves_to_the_code_default() {
    let r = resolve(K::ExitDateBackdateSoftDays, &[], None, NOW).unwrap();
    assert_eq!(
        (r.value, r.version),
        (V::Int(14), SettingVersionId::CodeDefault)
    );
}

#[test]
fn entity_beats_tenant_and_latest_in_force_wins_within_a_scope() {
    let site = Uuid::from_u128(77);
    let other = Uuid::from_u128(78);
    let rows = [
        row(1, None, -10, V::Int(10)),
        row(2, None, -5, V::Int(9)),
        row(3, None, 3, V::Int(3)), // future: not in force
        row(4, Some(site), -1, V::Int(5)),
        row(5, Some(other), -1, V::Int(4)),
    ];
    let key = K::ExitDateBackdateSoftDays;
    let tenant = resolve(key, &rows, None, NOW).unwrap();
    assert_eq!(tenant.value, V::Int(9));
    assert_eq!(
        tenant.version,
        SettingVersionId::Override(Uuid::from_u128(2))
    );
    assert_eq!(
        resolve(key, &rows, Some(site), NOW).unwrap().value,
        V::Int(5)
    );
    let unscoped_site = Uuid::from_u128(79);
    assert_eq!(
        resolve(key, &rows, Some(unscoped_site), NOW).unwrap().value,
        V::Int(9)
    );
    // Before the entity row starts, the tenant row applies.
    let earlier = NOW - Duration::days(2);
    assert_eq!(
        resolve(key, &rows, Some(site), earlier).unwrap().value,
        V::Int(9)
    );
    // Once the future row starts, it wins.
    let later = NOW + Duration::days(4);
    assert_eq!(resolve(key, &rows, None, later).unwrap().value, V::Int(3));
}

#[test]
fn an_undeclared_fact_is_an_error_not_a_default() {
    let err = resolve(K::WithholdingFilingCadence, &[], None, NOW).unwrap_err();
    assert_eq!(
        err,
        SettingError::FactUndeclared(K::WithholdingFilingCadence)
    );
    let rows = [row(1, None, 0, V::Code("MONTHLY"))];
    assert_eq!(
        resolve(K::WithholdingFilingCadence, &rows, None, NOW)
            .unwrap()
            .value,
        V::Code("MONTHLY")
    );
}

#[test]
fn keys_without_a_tenant_path_ignore_stray_rows() {
    let rows = [row(1, None, -1, V::Bool(true))];
    let r = resolve(K::OffboardingArchiveServiceEnabled, &rows, None, NOW).unwrap();
    assert_eq!(
        (r.value, r.version),
        (V::Bool(false), SettingVersionId::CodeDefault)
    );
    let err = check_change(
        K::OffboardingArchiveServiceEnabled,
        &json!(true),
        NOW,
        NOW,
        None,
        false,
    );
    assert_eq!(
        err.unwrap_err(),
        SettingError::NotEditable(K::OffboardingArchiveServiceEnabled)
    );
    let fixed = K::ApprovalRegisteredBranchChangeRequiresGoverningBody;
    assert!(check_change(fixed, &json!(false), NOW, NOW, None, true).is_err());
}

#[test]
fn tightening_applies_now_and_loosening_waits_a_day() {
    let key = K::ExitDateBackdateSoftDays;
    let tighten = check_change(key, &json!(7), NOW, NOW, Some(V::Int(14)), false).unwrap();
    assert_eq!(tighten.direction, Direction::Tighten);

    // Loosening is measured against the value in force, not the default.
    let err = check_change(key, &json!(10), NOW, NOW, Some(V::Int(7)), false).unwrap_err();
    assert_eq!(
        err,
        SettingError::LooseningTooSoon {
            key,
            earliest: NOW + Duration::hours(24)
        }
    );
    let later = NOW + Duration::hours(24);
    let ok = check_change(key, &json!(10), later, NOW, Some(V::Int(7)), false).unwrap();
    assert_eq!(ok.direction, Direction::Loosen);
    // Onboarding: no decision was made under the old value.
    assert!(check_change(key, &json!(10), NOW, NOW, Some(V::Int(7)), true).is_ok());
    // Same value is neutral.
    let same = check_change(key, &json!(7), NOW, NOW, Some(V::Int(7)), false).unwrap();
    assert_eq!(same.direction, Direction::Neutral);
}

#[test]
fn direction_follows_each_keys_risk_direction() {
    // Lower is looser for a minimum grant age.
    let key = K::AuthzSecondPersonMinGrantAge;
    assert!(check_change(key, &json!(3), NOW, NOW, Some(V::Int(7)), false).is_err());
    assert_eq!(
        check_change(key, &json!(14), NOW, NOW, Some(V::Int(7)), false)
            .unwrap()
            .direction,
        Direction::Tighten
    );
    // Codes are ordered strictest first.
    let mode = K::ExitAccessRevokeModeVoluntary;
    let on_confirm = check_change(
        mode,
        &json!("ON_CONFIRM"),
        NOW,
        NOW,
        Some(V::Code("END_OF_EXIT_DATE")),
        false,
    );
    assert_eq!(on_confirm.unwrap().direction, Direction::Tighten);
    assert!(
        check_change(
            K::ExitAccessRevokeModeInvoluntary,
            &json!("END_OF_EXIT_DATE"),
            NOW,
            NOW,
            Some(V::Code("ON_CONFIRM")),
            false
        )
        .is_err()
    );
}

#[test]
fn values_outside_kind_range_or_time_are_refused_with_codes() {
    let key = K::ExitDateBackdateSoftDays;
    let cases = [
        (json!("14"), NOW, "setting_value_invalid", "value"),
        (json!(14.5), NOW, "setting_value_invalid", "value"),
        (json!(15), NOW, "setting_out_of_range", "value"),
        (json!(2), NOW, "setting_out_of_range", "value"),
        (
            json!(7),
            NOW - Duration::seconds(1),
            "setting_backdated",
            "effective_from",
        ),
    ];
    for (raw, at, code, field) in cases {
        let err: KernelError = check_change(key, &raw, at, NOW, Some(V::Int(14)), true)
            .unwrap_err()
            .into();
        assert_eq!(
            (err.code, err.field.as_deref()),
            (Some(code), Some(field)),
            "{raw}"
        );
    }
    let mode = K::AuthzSoleHolderMode;
    assert!(check_change(mode, &json!("nope"), NOW, NOW, None, true).is_err());
}

#[test]
fn legal_floors_cannot_be_lowered_even_during_onboarding() {
    let key = K::AuditAccessLogRetention;
    let err = check_change(key, &json!(1), NOW, NOW, Some(V::Int(2)), true).unwrap_err();
    assert_eq!(err, SettingError::OutOfRange(key));
    let raise = check_change(key, &json!(5), NOW, NOW, Some(V::Int(2)), false).unwrap();
    assert_eq!(raise.direction, Direction::Tighten);
    let ceiling = K::OffboardingDestroyAfterDue;
    assert!(check_change(ceiling, &json!(6), NOW, NOW, Some(V::Int(5)), true).is_err());
}

#[test]
fn first_declaration_of_a_directional_fact_is_a_loosening() {
    let key = K::RetentionRecruitingDocs;
    assert!(check_change(key, &json!(180), NOW, NOW, None, false).is_err());
    assert!(check_change(key, &json!(180), NOW, NOW, None, true).is_ok());
    let cadence = check_change(
        K::WithholdingFilingCadence,
        &json!("SEMIANNUAL"),
        NOW,
        NOW,
        None,
        false,
    );
    assert_eq!(cadence.unwrap().direction, Direction::Neutral);
}

#[test]
fn snapshot_is_keyed_by_wire_string_with_value_and_version() {
    let mut snap = SettingsSnapshot::new();
    let rows = [row(9, None, -1, V::Int(5))];
    let v = snap.record(
        K::PeriodLockUnlockMaxDays,
        resolve(K::PeriodLockUnlockMaxDays, &rows, None, NOW).unwrap(),
    );
    assert_eq!(v, V::Int(5));
    snap.record(
        K::ExitAccessRevokeModeVoluntary,
        resolve(K::ExitAccessRevokeModeVoluntary, &[], None, NOW).unwrap(),
    );
    assert_eq!(
        snap.to_json().unwrap(),
        json!({
            "exit.access.revoke_mode.voluntary": {"value": "END_OF_EXIT_DATE", "version": "code_default"},
            "period_lock.unlock_max_days": {"value": 5, "version": {"override": Uuid::from_u128(9)}},
        })
    );
}
