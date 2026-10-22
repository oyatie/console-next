//! The key roster is complete, unique and self-consistent.
#![allow(clippy::unwrap_used, clippy::panic)]

use console_settings_domain::{Governance, LooserWhen, SettingKey, SettingKind, SettingValue};
use std::collections::HashSet;

/// 34 App. A keys (`doc_class.{a,b}` is two) + 17 retention classes +
/// `exit.settlement.wage_deviation_pct` + `authz.cross_entity_grant.basis_required`
/// (decisions #15.2) + `retention.entity_registration_document` + 10 EMP-RECORD
/// section switches + PEOPLE-A's two `people.void_*` + D26's six
/// `approval.policy.*` + IMPORT-2's nine `import.*` + BE-MIG's
/// `import.apply.max_rows` + PERF-BE's six `db.pool.*` and support-session ceilings.
const EXPECTED_KEYS: usize = 34 + 17 + 1 + 1 + 1 + 10 + 2 + 6 + 9 + 1 + 6 + 3 + 2 + 2 + 3;

#[test]
fn roster_has_every_key_once_and_round_trips() {
    assert_eq!(SettingKey::ALL.len(), EXPECTED_KEYS);
    let mut seen = HashSet::new();
    for key in SettingKey::ALL {
        assert!(seen.insert(key.as_str()), "duplicate {}", key.as_str());
        assert_eq!(key.as_str().parse::<SettingKey>().unwrap(), *key);
        assert_eq!(
            serde_json::to_string(key).unwrap(),
            format!("\"{}\"", key.as_str())
        );
    }
    assert_eq!(
        SettingKey::ALL
            .iter()
            .filter(|k| k.as_str().starts_with("retention."))
            .count(),
        18
    );
    assert!("exit.nope".parse::<SettingKey>().is_err());
}

#[test]
fn keys_consumed_by_other_lanes_keep_their_wire_strings() {
    assert_eq!(
        SettingKey::ApprovalPolicyImportRollback.as_str(),
        "approval.policy.import_rollback"
    );
    assert_eq!(
        SettingKey::ImportRollbackWindowDays.as_str(),
        "import.rollback.window_days"
    );
    // BW-29 reads these as consts (concurrency challenge D2).
    assert_eq!(
        SettingKey::AuthzSecondPersonMinGrantAge.as_str(),
        "authz.second_person.min_grant_age"
    );
    assert_eq!(
        SettingKey::AuthzSecondPersonResponseDue.as_str(),
        "authz.second_person.response_due"
    );
    assert_eq!(
        SettingKey::ExitDateBackdateSoftDays.as_str(),
        "exit.date.backdate_soft_days"
    );
}

#[test]
fn every_default_has_the_right_kind_and_sits_inside_its_bounds() {
    for key in SettingKey::ALL {
        let def = key.def();
        let Some(default) = def.default else {
            assert_eq!(
                def.governance,
                Governance::Tenant,
                "{key:?}: a fact must be declarable"
            );
            continue;
        };
        assert!(def.ordinal(default).is_some(), "{key:?}: default kind");
        if let (SettingKind::Int { min, max, .. }, SettingValue::Int(v)) = (def.kind, default) {
            assert!(min.is_none_or(|m| v >= m), "{key:?}: default below min");
            assert!(max.is_none_or(|m| v <= m), "{key:?}: default above max");
        }
    }
}

#[test]
fn only_neutral_keys_skip_a_risk_direction() {
    for key in SettingKey::ALL {
        let def = key.def();
        if def.looser_when == LooserWhen::Neutral {
            assert!(
                def.is_fact() || def.governance != Governance::Tenant,
                "{key:?}: a tenant-editable policy value needs a risk direction"
            );
        }
    }
}

#[test]
fn legal_floors_sit_on_the_code_default() {
    // Retention classes and audit logs may only be raised past the statute.
    for key in SettingKey::ALL {
        let name = key.as_str();
        if !(name.starts_with("retention.") || name.starts_with("audit.")) {
            continue;
        }
        let def = key.def();
        if let (SettingKind::Int { min, .. }, Some(SettingValue::Int(v))) = (def.kind, def.default)
        {
            assert_eq!(min, Some(v), "{name}");
            assert_eq!(def.looser_when, LooserWhen::Lower, "{name}");
        }
    }
}

#[test]
fn ops_recovery_settings_are_platform_only_and_keep_the_voice_code_cap() {
    for (wire, min, max, default) in [
        ("ops_recovery.hold_hours", 24, 168, 72),
        ("ops_recovery.code_ttl_minutes", 5, 10, 10),
    ] {
        let key: SettingKey = wire.parse().unwrap();
        assert!(SettingKey::ALL.contains(&key));
        let def = key.def();
        assert_eq!(def.governance, Governance::PlatformOnly);
        assert!(
            matches!(def.kind,SettingKind::Int{min:Some(lower),max:Some(upper),..} if lower==min && upper==max)
        );
        assert_eq!(def.default, Some(SettingValue::Int(default)));
        assert!(!def.in_range(SettingValue::Int(max + 1)));
    }
}
