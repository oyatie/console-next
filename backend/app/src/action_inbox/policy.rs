// SPDX-License-Identifier: LicenseRef-Proprietary
//! One settings snapshot per inbox request, shared by every source page.
use console_action_inbox_application::decision::DecisionPolicy;
use console_kernel_core::{KernelError, OrgId, Timestamp};
use console_settings_adapter_postgres::ResolvedSettings;
use console_settings_domain::{SettingKey, SettingValue};

pub(super) const KEYS: &[SettingKey] = &[
    SettingKey::DeadlineDueSoonDays,
    SettingKey::ApprovalPolicyOrgStructure,
    SettingKey::ApprovalBulkOrgStructure,
    SettingKey::ApprovalStepUpOrgStructure,
];

#[tracing::instrument(name = "action_inbox.policy", skip_all)]
pub(super) async fn load(
    conn: &mut sqlx::PgConnection,
    org: OrgId,
    now: Timestamp,
) -> Result<(i64, Option<DecisionPolicy>), KernelError> {
    let settings =
        console_settings_adapter_postgres::resolve_in_tx(conn, org, KEYS, None, now).await?;
    let window = settings
        .get(&SettingKey::DeadlineDueSoonDays)
        .and_then(|entry| entry.as_ref().ok())
        .and_then(|entry| entry.value.as_int())
        .ok_or_else(|| KernelError::internal("deadline display window unavailable"))?;
    Ok((window, org_structure(&settings)?))
}

pub(super) fn org_structure(
    settings: &ResolvedSettings,
) -> Result<Option<DecisionPolicy>, KernelError> {
    let value = |key| {
        settings
            .get(&key)
            .and_then(|entry| entry.as_ref().ok())
            .map(|entry| entry.value)
            .ok_or_else(|| KernelError::internal("inbox approval policy unavailable"))
    };
    let key = SettingKey::ApprovalPolicyOrgStructure;
    let SettingValue::Code(route) = value(key)? else {
        return Err(KernelError::internal("inbox approval route unavailable"));
    };
    let SettingValue::Bool(bulk) = value(SettingKey::ApprovalBulkOrgStructure)? else {
        return Err(KernelError::internal("inbox bulk policy unavailable"));
    };
    let SettingValue::Bool(step_up) = value(SettingKey::ApprovalStepUpOrgStructure)? else {
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
        assert!(!org_structure(&defaults).unwrap().unwrap().routed);
        for &key in &KEYS[1..] {
            let mut missing = defaults.clone();
            missing.remove(&key);
            assert!(org_structure(&missing).is_err(), "{key:?}");
            let mut mistyped = defaults.clone();
            mistyped.insert(
                key,
                Ok(Resolved {
                    value: SettingValue::Int(0),
                    version: SettingVersionId::CodeDefault,
                }),
            );
            assert!(org_structure(&mistyped).is_err(), "{key:?}");
        }
    }
}
