//! The hr-rest routers the B3 lanes ship for INTEG to mount (EMP-MODEL,
//! LIFE, PEOPLE-A), the B4 IMPORT half (EMP-CREATE 최저임금 hint, BW-19
//! 재입사) and BW-38 change sets (the EMP-RECORD 인사카드 router is mounted in
//! routes/people.rs) and the IMPORT-2 identity routes (주민등록번호, 사번 변경,
//! renumbering). They are merged inside the authenticated HR router, so the `Principal` extension
//! comes from the same request-context layer; their paths are registered as
//! their own `CONFIGURED_ROUTE_SURFACES` entries.

use axum::Router;
use console_hr_adapter_postgres::HrService;
use console_hr_rest::{
    bulk_corrections, bulk_lifecycle, change_sets, checklist, contract, corrections, fixed_term,
    identity, intake, job_title, lifecycle_bulk_job, lifecycle_void, notices, profile, reconcile,
    register_facts, registration, requests,
};
use console_platform_auth::PasskeyService;

use super::HrState;

impl HrState {
    /// The step-up verifier for the BW-18 corrections (see [`merge`]).
    #[must_use]
    pub fn with_passkey_step_up(mut self, passkeys: Option<PasskeyService>) -> Self {
        self.passkey_step_up = passkeys;
        self
    }
}

/// `corrections` verifies its step-ups with the policy passkey service; with
/// no WebAuthn configured (auth off) the correction routes are not mounted, so
/// a correction can never skip its step-up. Its step-up-free MR-26 routes
/// (SETUP delete, voided list) are always mounted.
pub(super) fn merge(router: Router, state: &HrState) -> Router {
    let hr: &HrService = &state.hr;
    let router = router
        .merge(identity::router(hr.clone(), state.rrn_vault.clone()))
        .merge(profile::router(hr.clone()))
        .merge(contract::router(hr.clone()))
        .merge(checklist::router(hr.clone()))
        .merge(fixed_term::router(hr.clone()))
        .merge(job_title::router(hr.clone()))
        .merge(lifecycle_void::router(
            hr.clone(),
            state.passkey_step_up.clone(),
        ))
        .merge(lifecycle_bulk_job::router(hr.clone()))
        .merge(requests::router(hr.clone()))
        .merge(registration::router(hr.clone()))
        .merge(intake::router(hr.clone()))
        .merge(change_sets::router(hr.clone()))
        .merge(register_facts::router(hr.clone()))
        .merge(corrections::setup_router(hr.clone()))
        // BE-EMP-UI: bulk 발령 preview, 발령 공고, 이관 확인.
        .merge(bulk_lifecycle::router(hr.clone()))
        .merge(notices::router(hr.clone()))
        .merge(reconcile::router(hr.clone()));
    match state.passkey_step_up.clone() {
        Some(passkeys) => router
            .merge(corrections::router(hr.clone(), passkeys.clone()))
            .merge(bulk_corrections::router(hr.clone(), passkeys)),
        None => router,
    }
}
