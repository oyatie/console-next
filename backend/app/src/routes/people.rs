//! People: HR and the 인사카드 (the MVP), then attendance, leave, recruiting
//! (incl. the hire handshake), evaluation, benefits and payroll (one mount each).

use axum::Router;

use super::TenantDeps;
use crate::hr;

pub(super) fn mount(router: Router, deps: &TenantDeps<'_>) -> Router {
    let (state, pool) = (deps.state, deps.pool);
    router
        .merge(hr::router({
            let hr_state = hr::HrState::new(pool.clone(), state.jwt_verifier.clone());
            hr_state
                .with_leave_command_store(deps.leave_store.clone())
                .with_passkey_step_up(state.policy_step_up.clone())
        }))
        .merge(console_platform_request_context::with_request_context(
            console_hr_rest::cases::router_with_passkeys(
                console_hr_adapter_postgres::HrService::new(pool.clone()),
                state.policy_step_up.clone(),
            ),
            state.jwt_verifier.clone(),
            pool.clone(),
        ))
        .merge(
            console_platform_request_context::with_request_context(
                console_hr_rest::statutory::router(
                    console_hr_adapter_postgres::HrService::new(pool.clone()),
                    console_compliance_adapter_postgres::PgComplianceStore::new(pool.clone()),
                ),
                state.jwt_verifier.clone(),
                pool.clone(),
            )
            .layer(axum::Extension(
                console_platform_request_context::record_access::outcome::Reader(
                    crate::requests::read_filing_outcome,
                ),
            )),
        )
        .merge(
            console_platform_request_context::with_request_context(
                console_hr_rest::certificates::router(console_hr_adapter_postgres::HrService::new(
                    pool.clone(),
                )),
                state.jwt_verifier.clone(),
                pool.clone(),
            )
            .layer(axum::Extension(
                console_platform_request_context::record_access::outcome::Reader(
                    crate::requests::read_certificate_outcome,
                ),
            )),
        )
        // EMP-RECORD 인사카드 sections (MR-31/33/35), behind the request context.
        .merge(console_platform_request_context::with_request_context(
            console_hr_rest::record::router(console_hr_adapter_postgres::HrService::new(
                pool.clone(),
            )),
            state.jwt_verifier.clone(),
            pool.clone(),
        ))
        // MR-34 인적사항 + 사진 (presigned upload to the primary media bucket).
        .merge(console_platform_request_context::with_request_context(
            console_hr_rest::personal_facts::router(
                console_hr_adapter_postgres::HrService::new(pool.clone()),
                state.sales_media_storage.as_ref().map(|(store, bucket)| {
                    console_hr_rest::personal_facts::PhotoStore {
                        store: std::sync::Arc::new(store.clone()),
                        bucket: bucket.clone(),
                    }
                }),
            ),
            state.jwt_verifier.clone(),
            pool.clone(),
        ))
}

#[cfg(feature = "attendance")]
pub(super) fn mount_attendance(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_attendance_rest::router(
        console_attendance_rest::AttendanceRestState::new(
            console_attendance_adapter_postgres::PgAttendanceStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

/// Leave-request queue + §61 statutory push. The push delivers a receipt-gated
/// notice through the SAME inbox vault (a fresh `PgInboxStore` over the shared
/// pool as the `InboxDocSink`).
#[cfg(feature = "leave")]
pub(super) fn mount_leave(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_leave_rest::router(
        console_leave_rest::LeaveRestState::new(
            deps.leave_store.clone(),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

/// Recruiting, plus the hire handshake, which stays app-level: it shares one
/// transaction with the HR-owned employee-creation core (see recruiting_hire).
#[cfg(feature = "recruiting")]
pub(super) fn mount_recruiting(router: Router, deps: &TenantDeps<'_>) -> Router {
    use crate::recruiting_hire;
    let (state, pool) = (deps.state, deps.pool);
    router
        .merge(console_recruiting_rest::router(
            console_recruiting_rest::RecruitingRestState::new(
                console_recruiting_adapter_postgres::PgRecruitingStore::new(pool.clone()),
                state.jwt_verifier.clone(),
            ),
        ))
        .merge(recruiting_hire::router(
            recruiting_hire::RecruitingHireState::new(
                pool.clone(),
                state.jwt_verifier.clone(),
                hr::HrState::new(pool.clone(), state.jwt_verifier.clone())
                    .with_leave_command_store(deps.leave_store.clone()),
            ),
        ))
}

#[cfg(feature = "evaluation")]
pub(super) fn mount_evaluation(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_evaluation_rest::router(
        console_evaluation_rest::EvaluationRestState::new(
            console_evaluation_adapter_postgres::PgEvaluationStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

#[cfg(feature = "benefit")]
pub(super) fn mount_benefit(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_benefit_rest::router(
        console_benefit_rest::BenefitRestState::new(
            console_benefit_adapter_postgres::PgBenefitCatalogStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}

/// Payroll draft-run visibility (admin org-wide + self payslips).
#[cfg(feature = "payroll")]
pub(super) fn mount_payroll(router: Router, deps: &TenantDeps<'_>) -> Router {
    router.merge(console_payroll_rest::router(
        console_payroll_rest::PayrollRestState::new(
            console_payroll_adapter_postgres::PgPayrollStore::new(deps.pool.clone()),
            deps.state.jwt_verifier.clone(),
        ),
    ))
}
