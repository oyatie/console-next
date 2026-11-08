// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) async fn get(
    State(s): State<OnboardingRestState>,
    h: HeaderMap,
) -> Result<Response, RestError> {
    let a = actor(&s, &h).await?;
    let mut modules = s.store.modules(&a).await?;
    for module in &mut modules {
        if module.key == "payroll" {
            module.ready &= s.payroll_compiled;
        }
    }
    modules.push(console_onboarding_domain::Module {
        key: "approvals",
        ready: s.approvals_released,
        unblock: None,
    });
    Ok(Json(modules).into_response())
}
