#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Pins what cargo-mutants found unpinned in settings-domain (tools/lanes/
//! mutants.sh): typed accessors, bool parsing, which keys are tenant facts,
//! and the refusal each SettingError becomes on the wire (kind, code, text).

use console_kernel_core::{ErrorKind, KernelError};
use console_settings_domain::{SettingError, SettingKey, SettingKind, SettingValue, UnknownKey};
use serde_json::json;

#[test]
fn each_accessor_answers_only_for_its_own_kind() {
    assert_eq!(SettingValue::Int(7).as_int(), Some(7));
    assert_eq!(SettingValue::Int(7).as_bool(), None);
    assert_eq!(SettingValue::Bool(true).as_bool(), Some(true));
    assert_eq!(SettingValue::Bool(false).as_bool(), Some(false));
    assert_eq!(SettingValue::Bool(true).as_code(), None);
    assert_eq!(SettingValue::Code("none").as_code(), Some("none"));
    assert_eq!(SettingValue::Code("none").as_int(), None);
}

#[test]
fn a_bool_key_parses_json_booleans_and_nothing_else() {
    let key = SettingKey::ALL
        .iter()
        .find(|k| matches!(k.def().kind, SettingKind::Bool));
    let key = key.expect("a bool key is registered");
    let def = key.def();
    assert_eq!(def.parse(&json!(true)), Some(SettingValue::Bool(true)));
    assert_eq!(def.parse(&json!(false)), Some(SettingValue::Bool(false)));
    for raw in [json!(1), json!("true"), json!(null)] {
        assert_eq!(def.parse(&raw), None, "{raw}");
    }
}

#[test]
fn a_fact_is_exactly_a_key_without_a_code_default() {
    for key in SettingKey::ALL {
        assert_eq!(
            key.def().is_fact(),
            key.def().default.is_none(),
            "{}",
            key.as_str()
        );
    }
    assert!(SettingKey::ALL.iter().any(|k| !k.def().is_fact()));
}

#[test]
fn every_setting_error_reaches_the_wire_with_its_kind_code_field_and_text() {
    let key = SettingKey::ALL[0];
    for (error, kind) in [
        (SettingError::NotEditable(key), ErrorKind::Validation),
        (SettingError::InvalidValue(key), ErrorKind::Validation),
        (SettingError::OutOfRange(key), ErrorKind::Validation),
        (SettingError::Backdated(key), ErrorKind::Validation),
        (SettingError::FactUndeclared(key), ErrorKind::Conflict),
    ] {
        let (code, field, text) = (error.code(), error.field(), error.to_string());
        assert!(text.contains(key.as_str()), "{text}");
        let wire = KernelError::from(error);
        assert_eq!(
            (wire.kind, wire.code, wire.field.as_deref()),
            (kind, Some(code), Some(field))
        );
        assert_eq!(wire.message, text);
    }
    assert_eq!(
        UnknownKey("x.y".into()).to_string(),
        "unknown setting key: x.y"
    );
}
