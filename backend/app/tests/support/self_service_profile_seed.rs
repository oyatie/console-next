// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::support::token_for;
use console_kernel_core::{OrgId, UserId};
use console_platform_test_support::soft_passkey::SoftKey;
use sqlx::PgPool;
use uuid::Uuid;

pub(crate) struct SeededProfileFixture {
    pub(crate) org_a: OrgId,
    pub(crate) org_b: OrgId,
    pub(crate) entity_a: Uuid,
    pub(crate) unit_a: Uuid,
    pub(crate) emp_a: Uuid,
    pub(crate) user_a: UserId,
    pub(crate) user_b: UserId,
    pub(crate) key: SoftKey,
    pub(crate) tok_a: String,
    pub(crate) tok_unlinked: String,
    pub(crate) tok_admin: String,
    pub(crate) tok_b: String,
}

pub(crate) async fn seed_profile_fixture(
    pool: &PgPool,
    priv_pem: &str,
    pub_pem: &str,
) -> SeededProfileFixture {
    let org_a = OrgId::one();
    let org_b = OrgId::new();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, 's6-b', 'S6 B') ON CONFLICT DO NOTHING")
        .bind(org_b.as_uuid()).execute(pool).await.unwrap();

    let (emp_a, emp_b, grade_id, entity_a, reg_a, br_a, wp_a, addr_id) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let (user_a, unlinked, admin_a, user_b) =
        (UserId::new(), UserId::new(), UserId::new(), UserId::new());
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, is_tenant_ops) VALUES ($1, 'Admin', $2, $3, true)")
        .bind(admin_a.as_uuid()).bind(["SUPER_ADMIN"].as_slice()).bind(org_a.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO regions (id, org_id, name) VALUES ($1, $2, 'Seoul')")
        .bind(reg_a)
        .bind(org_a.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO branches (id, org_id, region_id, name) VALUES ($1, $2, $3, 'HQ')")
        .bind(br_a)
        .bind(org_a.as_uuid())
        .bind(reg_a)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) VALUES ($1, $2, true, 'MIGRATION')")
        .bind(org_a.as_uuid()).bind(entity_a).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO legal_entity_revisions (org_id, legal_entity_id, version, command_id, effective_from, name, change_mode, reason_code, payload_digest, settings_snapshot) VALUES ($1, $2, 1, gen_random_uuid(), '2020-01-01', 'TestCorp', 'MIGRATION', 'MIGRATION', decode(repeat('ab', 32), 'hex'), '{}'::jsonb)")
        .bind(org_a.as_uuid()).bind(entity_a).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO workplaces (org_id, id, legal_entity_id, default_branch_id, needs_confirmation, created_change_mode) VALUES ($1, $2, $3, $4, true, 'MIGRATION')")
        .bind(org_a.as_uuid()).bind(wp_a).bind(entity_a).bind(br_a).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO job_titles (id, org_id, kind, label, grade_rank, active, created_by) VALUES ($1, $2, 'GRADE', 'Senior', 30, TRUE, $3)")
        .bind(grade_id).bind(org_a.as_uuid()).bind(admin_a.as_uuid()).execute(pool).await.unwrap();
    let unit_a = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id,id) VALUES ($1,$2)")
        .bind(org_a.as_uuid())
        .bind(unit_a)
        .execute(pool)
        .await
        .unwrap();
    for (org, eid, name) in [(org_a, emp_a, "Hong"), (org_b, emp_b, "OutsiderEmp")] {
        sqlx::query("INSERT INTO employees (id, org_id, company, name, position, employee_number, hire_date, hire_on, grade_id, org_unit_id, employment_status, source_filename, source_sheet, source_row, source_key) VALUES ($1, $2, 'Co', $3, 'Engineer', 'E-001', '2024-03-01', '2024-03-01', $4, $5, 'ACTIVE', 'f', 's', 1, $1::text)")
            .bind(eid).bind(org.as_uuid()).bind(name).bind((org == org_a).then_some(grade_id)).bind((org == org_a).then_some(unit_a)).execute(pool).await.unwrap();
    }
    sqlx::query("INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, actor_id, command_id) VALUES ($1, $2, $3, $4, '2024-03-01', 'HIRE', $5, gen_random_uuid())")
        .bind(org_a.as_uuid()).bind(emp_a).bind(entity_a).bind(wp_a).bind(admin_a.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO employee_addresses (id, org_id, employee_id, source, zip_no, adm_cd, bd_mgt_sn, road_addr_part1, road_addr_part2, detail, si_nm, sgg_nm, emd_nm, created_by) VALUES ($1, $2, $3, 'JUSO', '06236', '1168010100', '1168010100107000000000001', '152 Teheran-ro', 'Yeoksam', '10F', 'Seoul', 'Gangnam', 'Yeoksam', $4)")
        .bind(addr_id).bind(org_a.as_uuid()).bind(emp_a).bind(admin_a.as_uuid()).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO employee_register_facts (org_id, employee_id, address_id) VALUES ($1, $2, $3)",
    )
    .bind(org_a.as_uuid())
    .bind(emp_a)
    .bind(addr_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, employee_id, phone) VALUES ($1, 'Hong', $2, $3, $4, '+821012345678')")
        .bind(user_a.as_uuid()).bind(["MEMBER"].as_slice()).bind(org_a.as_uuid()).bind(emp_a).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'Unlinked', $2, $3)",
    )
    .bind(unlinked.as_uuid())
    .bind(["MEMBER"].as_slice())
    .bind(org_a.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id, employee_id) VALUES ($1, 'Outsider', $2, $3, $4)")
        .bind(user_b.as_uuid()).bind(["MEMBER"].as_slice()).bind(org_b.as_uuid()).bind(emp_b).execute(pool).await.unwrap();

    let key = SoftKey::enroll(pool, org_a, user_a).await;
    SeededProfileFixture {
        org_a,
        org_b,
        entity_a,
        unit_a,
        emp_a,
        user_a,
        user_b,
        key,
        tok_a: token_for(
            pool,
            priv_pem,
            pub_pem,
            org_a,
            user_a,
            vec!["MEMBER".into()],
            vec![],
        )
        .await,
        tok_unlinked: token_for(
            pool,
            priv_pem,
            pub_pem,
            org_a,
            unlinked,
            vec!["MEMBER".into()],
            vec![],
        )
        .await,
        tok_admin: token_for(
            pool,
            priv_pem,
            pub_pem,
            org_a,
            admin_a,
            vec!["SUPER_ADMIN".into()],
            vec![],
        )
        .await,
        tok_b: token_for(
            pool,
            priv_pem,
            pub_pem,
            org_b,
            user_b,
            vec!["MEMBER".into()],
            vec![],
        )
        .await,
    }
}
