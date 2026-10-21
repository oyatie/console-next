#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! IMPORT lane, BW-19: duplicate candidates and their governed override,
//! distinct conflict codes, 입사 예정 (PRE_HIRE) and 재입사 (REHIRE), on a
//! `console_rt` pool (the grants and RLS are part of what is proved).

mod branch;
#[path = "../emp_create/fixture.rs"]
mod fixture;
mod import;
mod import_apply;
mod import_fixture;
mod import_place;
mod placement;
mod register;
mod rehire;

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::directory::create::register_in_tx;
use console_hr_adapter_postgres::directory::normalize::normalize_create_employee_request;
use console_hr_adapter_postgres::directory::types::{
    CreateEmployeeRequest, EmployeeCreateWarning, EmployeeDetailResponse,
};
use uuid::Uuid;

/// The registration transaction `POST /api/v1/employees` runs (minus the
/// audit row and the post-commit home-branch routing).
pub async fn register(
    f: &fixture::Fixture,
    body: CreateEmployeeRequest,
) -> Result<(EmployeeDetailResponse, Option<EmployeeCreateWarning>), HrError> {
    let request = normalize_create_employee_request(body)?;
    let org = f.principal.org_id;
    let mut tx = f.rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let (detail, _, warning) =
        register_in_tx(&mut tx, org, f.principal.user_id, &request, Uuid::new_v4()).await?;
    tx.commit().await.unwrap();
    Ok((detail, warning))
}

/// `YYYY-MM-DD` of today (KST) plus `days`.
pub fn kst_day(days: i64) -> String {
    (console_hr_adapter_postgres::clock::today_kst() + time::Duration::days(days)).to_string()
}
