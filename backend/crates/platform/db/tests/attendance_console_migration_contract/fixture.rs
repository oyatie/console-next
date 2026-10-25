// SPDX-License-Identifier: LicenseRef-Proprietary
//! Existing attendance setup; the contract test retains every assertion.
use super::*;

pub(super) struct Seeded {
    pub(super) branch: Uuid,
    pub(super) employee: Uuid,
    pub(super) user: Uuid,
}

pub(super) async fn seed_org(pool: &PgPool, org: Uuid, tag: &str) -> Seeded {
    let region = Uuid::new_v4();
    let branch = Uuid::new_v4();
    let employee = Uuid::new_v4();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
        .bind(org)
        .bind(format!("attendance-contract-{tag}"))
        .bind(format!("Attendance contract {tag}"))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)")
        .bind(region)
        .bind(format!("Region {tag}"))
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
        .bind(branch)
        .bind(region)
        .bind(format!("Branch {tag}"))
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(user)
        .bind(format!("User {tag}"))
        .bind(vec!["MECHANIC".to_owned()])
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, source_row, source_key) \
         VALUES ($1, $2, 'Maintenance', $3, 'attendance-contract', 'employees', 1, $4)",
    )
    .bind(employee)
    .bind(org)
    .bind(format!("Employee {tag}"))
    .bind(format!("attendance-contract-{tag}"))
    .execute(pool)
    .await
    .unwrap();
    Seeded {
        branch,
        employee,
        user,
    }
}
