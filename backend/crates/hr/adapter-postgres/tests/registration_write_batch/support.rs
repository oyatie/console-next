// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use sqlx::{Postgres, Transaction};
use time::Duration;

pub async fn transaction(f: &fixture::Fixture) -> Transaction<'static, Postgres> {
    let mut tx = f.rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(f.principal.org_id.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx
}

pub async fn requests(f: &fixture::Fixture, pool: &PgPool) -> Vec<NormalizedCreateEmployeeRequest> {
    let mut units = Vec::new();
    for n in 0..3 {
        let unit = Uuid::new_v4();
        let name = format!("Synthetic unit {n}");
        sqlx::query("INSERT INTO org_units (org_id,id) VALUES ($1,$2)")
            .bind(f.principal.org_id.as_uuid())
            .bind(unit)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO org_unit_revisions \
             (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) \
             VALUES ($1,$2,1,gen_random_uuid(),$3,decode(repeat('00',32),'hex'),$4,'{}'::jsonb)",
        )
        .bind(f.principal.org_id.as_uuid())
        .bind(unit)
        .bind(f.principal.user_id.as_uuid())
        .bind(serde_json::json!({"name": name, "kind": "department"}))
        .execute(pool)
        .await
        .unwrap();
        units.push((unit, name));
    }
    (0..3)
        .map(|n| {
            let mut body = f.body(
                &format!("registration-{n}"),
                if n == 1 { "CONTRACT" } else { "REGULAR" },
            );
            body.name = format!("Synthetic employee {n}");
            body.employee_number = format!("BATCH-{n}");
            body.company = format!("Synthetic company {n}");
            body.org_unit_id = Some(units[n].0);
            body.org_unit = units[n].1.clone();
            body.position = format!("Synthetic position {n}");
            body.site = format!("Synthetic site {n}");
            body.phone = format!("010-0000-{n:04}");
            body.home_branch_id = None;
            body.base_pay = (3_000_000 + n * 100_000).to_string();
            body.hire_date =
                Some((today_kst() + Duration::days(if n == 2 { 1 } else { -1 })).to_string());
            if n == 1 {
                body.contract_end_date = Some((today_kst() + Duration::days(30)).to_string());
            }
            normalize_create_employee_request(body).unwrap()
        })
        .collect()
}

pub fn hashes(requests: &[NormalizedCreateEmployeeRequest]) -> Vec<String> {
    requests
        .iter()
        .map(|request| {
            console_hr_adapter_postgres::digest::sha256_hex(
                serde_json::to_string(request).unwrap().as_bytes(),
            )
        })
        .collect()
}

pub fn inputs<'a>(
    requests: &'a [NormalizedCreateEmployeeRequest],
    hashes: &'a [String],
) -> Vec<RegistrationInput<'a>> {
    requests
        .iter()
        .zip(hashes)
        .map(|(request, hash)| RegistrationInput {
            request,
            request_hash: hash,
            employee_id: Uuid::new_v4(),
        })
        .collect()
}

pub fn observe() -> trail_queries::Queries {
    static DISPATCH: std::sync::OnceLock<tracing::Dispatch> = std::sync::OnceLock::new();
    DISPATCH.get_or_init(|| tracing::Dispatch::new(trail_queries::Queries::default()));
    trail_queries::Queries::default()
}

pub fn assert_batched(queries: &trail_queries::Queries, expected: usize) {
    for sql in [
        "INSERT INTO employees (",
        "INSERT INTO persons (",
        "INSERT INTO employment_heads",
        "INSERT INTO employee_lifecycle_events",
        "INSERT INTO lifecycle_cases (org_id,id,kind,variant",
        "INSERT INTO lifecycle_case_items (org_id,case_id,item_key",
        "INSERT INTO employee_employment_profiles (",
        "UPDATE employee_create_idempotency SET employee_id",
    ] {
        assert_eq!(
            queries
                .statements()
                .iter()
                .filter(|s| s.contains(sql))
                .count(),
            expected,
            "{sql}"
        );
    }
}

pub async fn counts(pool: &PgPool, f: &fixture::Fixture) -> Vec<i64> {
    sqlx::query_scalar(
        "SELECT ARRAY[
        (SELECT count(*) FROM employees WHERE org_id=$1),
        (SELECT count(*) FROM persons WHERE org_id=$1),
        (SELECT count(*) FROM employee_employment_profiles WHERE org_id=$1),
        (SELECT count(*) FROM employee_create_idempotency WHERE org_id=$1),
        (SELECT count(*) FROM employee_lifecycle_events WHERE org_id=$1),
        (SELECT count(*) FROM employment_heads WHERE org_id=$1),
        (SELECT count(*) FROM ont_action_command_receipts WHERE org_id=$1),
        (SELECT count(*) FROM lifecycle_cases WHERE org_id=$1)]",
    )
    .bind(f.principal.org_id.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}
