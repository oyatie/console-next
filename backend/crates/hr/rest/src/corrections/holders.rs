//! The BW-29 second-person facts for an org-wide HR correction or a
//! change-request decision: identity's
//! D0.2 count of other eligible holders and the resolved
//! `authz.sole_holder.mode`. Computed here because hr-adapter may not depend
//! on identity-adapter (layer-boundary); the HR service takes them as input,
//! as governance's exception admission does.

use console_hr_adapter_postgres::corrections::SecondPersonContext;
use console_hr_adapter_postgres::{HrError, HrService};
use console_identity_adapter_postgres::second_person::{
    SecondPersonQuery, second_person_fact_in_tx,
};
use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use console_settings_adapter_postgres::{ResolvedSettings, approval_routes_in_tx, resolve_in_tx};
use console_settings_domain::{SettingKey, SettingValue};
use time::OffsetDateTime;

use crate::HrApiError;

fn setting(settings: &ResolvedSettings, key: SettingKey) -> Result<SettingValue, KernelError> {
    match settings.get(&key) {
        Some(Ok(resolved)) => Ok(resolved.value),
        _ => Err(KernelError::internal(format!(
            "setting {} did not resolve",
            key.as_str()
        ))),
    }
}

/// `policy` names the act's `approval.policy.<class>` key (decisions #26);
/// `None` for a change-request decision, which is the route itself.
pub(crate) async fn second_person_context(
    hr: &HrService,
    principal: &Principal,
    policy: Option<SettingKey>,
) -> Result<SecondPersonContext, HrApiError> {
    let org = principal.org_id;
    let requester = principal.user_id;
    let context = with_org_conn::<_, _, HrError>(hr.pool(), org, move |tx| {
        Box::pin(async move {
            let now = OffsetDateTime::now_utc();
            let keys = [
                SettingKey::AuthzSecondPersonMinGrantAge,
                SettingKey::AuthzSoleHolderMode,
            ];
            let settings = resolve_in_tx(tx.as_mut(), org, &keys, None, now).await?;
            let min_grant_age_days = match setting(&settings, keys[0])? {
                SettingValue::Int(days) => i32::try_from(days).map_err(|_| {
                    KernelError::internal("authz.second_person.min_grant_age is out of range")
                })?,
                _ => {
                    return Err(KernelError::internal(
                        "authz.second_person.min_grant_age is not an integer",
                    )
                    .into());
                }
            };
            // Fail closed: anything but the documented loosening reads as refuse.
            let sole_holder_refuse = !matches!(
                setting(&settings, keys[1])?,
                SettingValue::Code("step_up_notice_review")
            );
            let fact = second_person_fact_in_tx(
                tx,
                &SecondPersonQuery {
                    org,
                    feature: Feature::EmployeeDirectoryManage,
                    // A correction is an org-wide HR act: all-scope holders only.
                    branch: None,
                    requester,
                    excluded: Vec::new(),
                    case_created_at: now,
                    min_grant_age_days,
                },
            )
            .await?;
            let routed = match policy {
                Some(key) => approval_routes_in_tx(tx.as_mut(), org, key).await?,
                None => true,
            };
            Ok(SecondPersonContext {
                other_eligible_holders: u64::try_from(fact.other_eligible_holders).unwrap_or(0),
                sole_holder_refuse,
                routed,
            })
        })
    })
    .await?;
    Ok(context)
}
