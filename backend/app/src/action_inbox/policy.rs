// SPDX-License-Identifier: LicenseRef-Proprietary
//! One settings snapshot per inbox request, shared by every source page.
use console_action_inbox_application::decision::DecisionPolicy;
use console_kernel_core::{KernelError, OrgId, Timestamp};
use console_settings_adapter_postgres::ResolvedSettings;
use console_settings_domain::{SettingKey, SettingValue};
use std::collections::BTreeMap;

pub(super) type Policies = BTreeMap<SettingKey, Option<DecisionPolicy>>;

pub(super) const KEYS: &[SettingKey] = &[
    SettingKey::DeadlineDueSoonDays,
    SettingKey::InboxSnoozeShortDays,
    SettingKey::InboxSnoozeLongDays,
    SettingKey::ApprovalPolicyOrgStructure,
    SettingKey::ApprovalBulkOrgStructure,
    SettingKey::ApprovalStepUpOrgStructure,
    SettingKey::ApprovalPolicyPeopleCorrection,
    SettingKey::ApprovalBulkPeopleCorrection,
    SettingKey::ApprovalStepUpPeopleCorrection,
    SettingKey::ApprovalPolicyIdentityMerge,
    SettingKey::ApprovalBulkIdentityMerge,
    SettingKey::ApprovalStepUpIdentityMerge,
    SettingKey::ApprovalPolicyImportRollback,
    SettingKey::ApprovalBulkImportRollback,
    SettingKey::ApprovalStepUpImportRollback,
    SettingKey::ApprovalPolicyRegistrationVoid,
    SettingKey::ApprovalBulkRegistrationVoid,
    SettingKey::ApprovalStepUpRegistrationVoid,
];

/// The display keys come first; the decision policies follow, three keys each.
const KEYS_BEFORE_POLICIES: usize = 3;

#[tracing::instrument(name = "action_inbox.policy", skip_all)]
pub(super) async fn load(
    conn: &mut sqlx::PgConnection,
    org: OrgId,
    now: Timestamp,
) -> Result<(i64, Policies, [i64; 2]), KernelError> {
    let settings =
        console_settings_adapter_postgres::resolve_in_tx(conn, org, KEYS, None, now).await?;
    let days = |key, missing: &'static str| {
        settings
            .get(&key)
            .and_then(|entry| entry.as_ref().ok())
            .and_then(|entry| entry.value.as_int())
            .ok_or_else(|| KernelError::internal(missing))
    };
    let window = days(
        SettingKey::DeadlineDueSoonDays,
        "deadline display window unavailable",
    )?;
    let snooze = [
        days(
            SettingKey::InboxSnoozeShortDays,
            "snooze presets unavailable",
        )?,
        days(
            SettingKey::InboxSnoozeLongDays,
            "snooze presets unavailable",
        )?,
    ];
    let policies = KEYS[KEYS_BEFORE_POLICIES..]
        .as_chunks::<3>()
        .0
        .iter()
        .map(|keys| Ok((keys[0], resolve_policy(&settings, keys)?)))
        .collect::<Result<_, KernelError>>()?;
    Ok((window, policies, snooze))
}

fn resolve_policy(
    settings: &ResolvedSettings,
    keys: &[SettingKey],
) -> Result<Option<DecisionPolicy>, KernelError> {
    let value = |key| {
        settings
            .get(&key)
            .and_then(|entry| entry.as_ref().ok())
            .map(|entry| entry.value)
            .ok_or_else(|| KernelError::internal("inbox approval policy unavailable"))
    };
    let key = keys[0];
    let SettingValue::Code(route) = value(key)? else {
        return Err(KernelError::internal("inbox approval route unavailable"));
    };
    let SettingValue::Bool(bulk) = value(keys[1])? else {
        return Err(KernelError::internal("inbox bulk policy unavailable"));
    };
    let SettingValue::Bool(step_up) = value(keys[2])? else {
        return Err(KernelError::internal("inbox step-up policy unavailable"));
    };
    Ok(Some(DecisionPolicy::new(
        key,
        route != "none",
        bulk,
        step_up,
    )))
}

#[cfg(all(test, not(feature = "test-postgres")))]
mod tests {
    use super::*;
    use console_kernel_core::{Resolved, SettingVersionId};

    #[test]
    fn missing_or_mistyped_policy_values_never_become_defaults() {
        let defaults: ResolvedSettings = KEYS
            .iter()
            .map(|&key| {
                (
                    key,
                    Ok(Resolved {
                        value: key.def().default.unwrap(),
                        version: SettingVersionId::CodeDefault,
                    }),
                )
            })
            .collect();
        for keys in KEYS[KEYS_BEFORE_POLICIES..].as_chunks::<3>().0 {
            assert!(!resolve_policy(&defaults, keys).unwrap().unwrap().routed);
            for &key in keys {
                let mut missing = defaults.clone();
                missing.remove(&key);
                assert!(resolve_policy(&missing, keys).is_err(), "{key:?}");
                let mut mistyped = defaults.clone();
                mistyped.insert(
                    key,
                    Ok(Resolved {
                        value: SettingValue::Int(0),
                        version: SettingVersionId::CodeDefault,
                    }),
                );
                assert!(resolve_policy(&mistyped, keys).is_err(), "{key:?}");
            }
        }
    }
}
