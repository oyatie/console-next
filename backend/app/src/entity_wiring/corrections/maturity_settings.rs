// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::expect_used)]
use super::*;
use console_kernel_core::{ErrorKind, Resolved, SettingVersionId};
use console_platform_db::settings_read::ResolvedSettings;
use console_settings_domain::SettingError;

#[test]
fn missing_or_unresolved_grant_age_fails_closed() {
    let mut settings = ResolvedSettings::new();
    for value in [
        None,
        Some(Err(SettingError::FactUndeclared(
            SettingKey::AuthzSecondPersonMinGrantAge,
        ))),
    ] {
        settings.clear();
        if let Some(value) = value {
            settings.insert(SettingKey::AuthzSecondPersonMinGrantAge, value);
        }
        let error =
            grant_age_days(&settings).expect_err("no literal fallback without a resolved policy");
        assert_eq!(error.kind, ErrorKind::Internal);
        assert_eq!(
            error.message,
            "authz.second_person.min_grant_age did not resolve"
        );
    }
}

#[test]
fn non_integer_grant_age_fails_closed() {
    let settings = ResolvedSettings::from([(
        SettingKey::AuthzSecondPersonMinGrantAge,
        Ok(Resolved {
            value: SettingValue::Bool(false),
            version: SettingVersionId::CodeDefault,
        }),
    )]);
    let error = grant_age_days(&settings).expect_err("a non-integer policy must refuse");
    assert_eq!(error.kind, ErrorKind::Internal);
    assert_eq!(
        error.message,
        "authz.second_person.min_grant_age is not a number"
    );
}

#[test]
fn resolved_grant_age_is_preserved_and_overflow_refused() {
    for (days, expected) in [(0, Some(0)), (17, Some(17)), (i64::MAX, None)] {
        let settings = ResolvedSettings::from([(
            SettingKey::AuthzSecondPersonMinGrantAge,
            Ok(Resolved {
                value: SettingValue::Int(days),
                version: SettingVersionId::CodeDefault,
            }),
        )]);
        assert_eq!(grant_age_days(&settings).ok(), expected);
    }
}
