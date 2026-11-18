// SPDX-License-Identifier: LicenseRef-Proprietary
//! Scale fixtures use the product registration writer, including canonical heads and hire cases.
use console_hr_adapter_postgres::{
    clock::today_kst,
    directory::{
        create_core::write_registrations_core, create_prepare::RegistrationInput,
        normalize::normalize_create_employee_request,
    },
};
use time::Duration;
use uuid::Uuid;

pub async fn hires(f: &super::fixture::Fixture, people: usize) -> Vec<Uuid> {
    let hire_on = today_kst() - Duration::days(1);
    let requests: Vec<_> = (0..people)
        .map(|n| {
            let mut body = f.body(&format!("lifecycle-scale-{n}"), "REGULAR");
            body.name = format!("Synthetic employee {n}");
            body.position = "Synthetic position".into();
            body.site = "Synthetic site".into();
            body.employee_number = format!("TRAIL-{n}");
            body.hire_date = Some(hire_on.to_string());
            body.home_branch_id = None;
            normalize_create_employee_request(body).unwrap()
        })
        .collect();
    let hashes: Vec<_> = requests
        .iter()
        .map(|request| {
            console_hr_adapter_postgres::digest::sha256_hex(
                serde_json::to_string(request).unwrap().as_bytes(),
            )
        })
        .collect();
    let inputs: Vec<_> = requests
        .iter()
        .zip(&hashes)
        .map(|(request, hash)| RegistrationInput {
            request,
            request_hash: hash,
            employee_id: Uuid::new_v4(),
        })
        .collect();
    let mut tx = f.rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(f.principal.org_id.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let registered = write_registrations_core(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &inputs,
    )
    .await
    .unwrap();
    assert_eq!(registered.len(), people);
    let employees = registered
        .iter()
        .zip(&inputs)
        .map(|(row, input)| {
            assert!(!row.replayed);
            assert_eq!(row.employee_id, input.employee_id);
            row.employee_id
        })
        .collect();
    tx.commit().await.unwrap();
    employees
}
