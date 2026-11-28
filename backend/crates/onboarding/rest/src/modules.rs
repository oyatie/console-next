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
    for (key, ready) in [
        ("approvals", s.approvals_released),
        (
            "approval_submission",
            s.approvals_released && s.personal_tasks.workspace,
        ),
        ("personal_location", s.personal_tasks.location),
        ("dispatch_offers", s.personal_tasks.dispatch),
    ] {
        modules.push(console_onboarding_domain::Module {
            key,
            ready,
            unblock: None,
        });
    }
    Ok(Json(modules).into_response())
}
