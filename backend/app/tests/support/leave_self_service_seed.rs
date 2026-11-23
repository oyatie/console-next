// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::support::token_for;
use console_kernel_core::{BranchId, OrgId, UserId};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

pub(crate) struct SeededLeaveFixture {
    pub(crate) org_a: OrgId,
    pub(crate) t_a: String,
    pub(crate) t_mate: String,
    pub(crate) t_branchless: String,
    pub(crate) t_unlinked: String,
    pub(crate) t_b: String,
}

pub(crate) async fn seed_leave_fixture(
    pool: &PgPool,
    priv_pem: &str,
    pub_pem: &str,
) -> SeededLeaveFixture {
    let org_a = OrgId::one();
    let org_b = OrgId::new();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, 's7-b', 'S7 B') ON CONFLICT DO NOTHING")
        .bind(org_b.as_uuid()).execute(pool).await.unwrap();

    let (branch_a, branch_b) = (BranchId::new(), BranchId::new());
    let (entity_a, wp_a, unit_1, unit_2) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let (emp_a, emp_mate, emp_other_unit, emp_lead, emp_branchless) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let (u_a, u_mate, u_lead, u_branchless, u_unlinked, u_b) = (
        UserId::new(),
        UserId::new(),
        UserId::new(),
        UserId::new(),
        UserId::new(),
        UserId::new(),
    );

    let (reg_a, reg_b) = (Uuid::new_v4(), Uuid::new_v4());
    for (rid, org, name) in [(reg_a, org_a, "Seoul"), (reg_b, org_b, "Busan")] {
        sqlx::query("INSERT INTO regions (id, org_id, name) VALUES ($1, $2, $3)")
            .bind(rid)
            .bind(org.as_uuid())
            .bind(name)
            .execute(pool)
            .await
            .unwrap();
    }
    for (bid, org, rid, name) in [
        (branch_a, org_a, reg_a, "HQ"),
        (branch_b, org_b, reg_b, "Busan"),
    ] {
        sqlx::query("INSERT INTO branches (id, org_id, region_id, name) VALUES ($1, $2, $3, $4)")
            .bind(bid.as_uuid())
            .bind(org.as_uuid())
            .bind(rid)
            .bind(name)
            .execute(pool)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) VALUES ($1, $2, true, 'MIGRATION')").bind(org_a.as_uuid()).bind(entity_a).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO legal_entity_revisions (org_id, legal_entity_id, version, command_id, effective_from, name, change_mode, reason_code, payload_digest, settings_snapshot) VALUES ($1, $2, 1, gen_random_uuid(), '2020-01-01', 'TestCorp', 'MIGRATION', 'MIGRATION', decode(repeat('ab', 32), 'hex'), '{}'::jsonb)").bind(org_a.as_uuid()).bind(entity_a).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO workplaces (org_id, id, legal_entity_id, default_branch_id, needs_confirmation, created_change_mode) VALUES ($1, $2, $3, $4, true, 'MIGRATION')")
        .bind(org_a.as_uuid()).bind(wp_a).bind(entity_a).bind(branch_a.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO workplace_revisions (org_id, workplace_id, version, command_id, effective_from, name, status, change_mode, reason_code, payload_digest, settings_snapshot) VALUES ($1, $2, 1, gen_random_uuid(), '2020-01-01', 'HQ', 'CONTINUING', 'MIGRATION', 'MIGRATION', decode(repeat('ab', 32), 'hex'), '{}'::jsonb)")
        .bind(org_a.as_uuid()).bind(wp_a).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'TeamLead', $2, $3)",
    )
    .bind(u_lead.as_uuid())
    .bind(["ADMIN"].as_slice())
    .bind(org_a.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_branches (org_id, user_id, branch_id) VALUES ($1, $2, $3)")
        .bind(org_a.as_uuid())
        .bind(u_lead.as_uuid())
        .bind(branch_a.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    for (uid_org, name) in [(unit_1, "Product"), (unit_2, "Sales")] {
        sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
            .bind(org_a.as_uuid())
            .bind(uid_org)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) VALUES ($1, $2, 1, gen_random_uuid(), $3, decode(repeat('aa',32),'hex'), jsonb_build_object('name', $4, 'kind', 'department', 'status', 'active'), '{}'::jsonb)")
            .bind(org_a.as_uuid()).bind(uid_org).bind(u_lead.as_uuid()).bind(name).execute(pool).await.unwrap();
    }
    let pattern_id = Uuid::new_v4();
    let work = json!({"kind": "WORK", "shift": {"start": 540, "end": 1080, "breaks": [{"start": 720, "end": 780}]}});
    let spec = json!({
        "kind": "WEEKLY",
        "days": [work, work, work, work, work, {"kind": "REST_DAY"}, {"kind": "WEEKLY_HOLIDAY"}],
        "holiday_rule": "OFF"
    });
    sqlx::query("INSERT INTO attendance_work_patterns (id, org_id, name, kind, spec, weekly_minutes, cycle_days, created_by, idempotency_key, request_fingerprint) VALUES ($1, $2, 'Mon-Fri', 'WEEKLY', $3, 2400, 7, $4, gen_random_uuid()::text, repeat('a', 64))")
        .bind(pattern_id).bind(org_a.as_uuid()).bind(spec).bind(u_lead.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO attendance_schedule_layers (id, org_id, scope_kind, legal_entity_id, pattern_id, effective_from, version, created_by, idempotency_key, request_fingerprint) VALUES (gen_random_uuid(), $1, 'LEGAL_ENTITY', $2, $3, '2026-01-01', 1, $4, gen_random_uuid()::text, repeat('b', 64))")
        .bind(org_a.as_uuid()).bind(entity_a).bind(pattern_id).bind(u_lead.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO attendance_public_holidays (holiday_date, name, kind, substitute_for, basis, edition) VALUES ('2026-07-17', 'ConstitutionDay', 'NATIONAL', NULL, 'LAW', '2026') ON CONFLICT DO NOTHING")
        .execute(pool).await.unwrap();

    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_leave_definer")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org_a.as_uuid().to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    for (eid, name, unit_id, br) in [
        (emp_a, "Requester", unit_1, Some(*branch_a.as_uuid())),
        (emp_mate, "Teammate", unit_1, Some(*branch_a.as_uuid())),
        (
            emp_other_unit,
            "OtherUnit",
            unit_2,
            Some(*branch_a.as_uuid()),
        ),
        (emp_lead, "TeamLead", unit_1, Some(*branch_a.as_uuid())),
        (emp_branchless, "Branchless", unit_1, None),
    ] {
        sqlx::query("INSERT INTO employees (id, org_id, company, name, position, hire_date, hire_on, org_unit_id, home_branch_id, employment_status, source_filename, source_sheet, source_row, source_key) VALUES ($1, $2, 'Co', $3, 'Manager', '2024-01-01', '2024-01-01', $4, $5, 'ACTIVE', 'f', 's', 1, $1::text)")
            .bind(eid).bind(org_a.as_uuid()).bind(name).bind(unit_id).bind(br).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    for eid in [emp_a, emp_mate, emp_other_unit, emp_lead, emp_branchless] {
        sqlx::query("INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, actor_id, command_id) VALUES ($1, $2, $3, $4, '2024-01-01', 'HIRE', $5, gen_random_uuid())")
            .bind(org_a.as_uuid()).bind(eid).bind(entity_a).bind(wp_a).bind(u_lead.as_uuid()).execute(pool).await.unwrap();
    }
    sqlx::query("UPDATE users SET employee_id = $2 WHERE id = $1")
        .bind(u_lead.as_uuid())
        .bind(emp_lead)
        .execute(pool)
        .await
        .unwrap();
    for (uid, name, eid) in [
        (u_a, "Requester", emp_a),
        (u_mate, "Teammate", emp_mate),
        (u_branchless, "Branchless", emp_branchless),
    ] {
        sqlx::query("INSERT INTO users (id, display_name, roles, org_id, employee_id) VALUES ($1, $2, $3, $4, $5)")
            .bind(uid.as_uuid()).bind(name).bind(["MEMBER"].as_slice()).bind(org_a.as_uuid()).bind(eid).execute(pool).await.unwrap();
    }
    for (uid, org, name) in [(u_unlinked, org_a, "Unlinked"), (u_b, org_b, "Outsider")] {
        sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
            .bind(uid.as_uuid())
            .bind(name)
            .bind(["MEMBER"].as_slice())
            .bind(org.as_uuid())
            .execute(pool)
            .await
            .unwrap();
    }

    SeededLeaveFixture {
        org_a,
        t_a: token_for(
            pool,
            priv_pem,
            pub_pem,
            org_a,
            u_a,
            vec!["MEMBER".into()],
            vec![branch_a],
        )
        .await,
        t_mate: token_for(
            pool,
            priv_pem,
            pub_pem,
            org_a,
            u_mate,
            vec!["MEMBER".into()],
            vec![branch_a],
        )
        .await,
        t_branchless: token_for(
            pool,
            priv_pem,
            pub_pem,
            org_a,
            u_branchless,
            vec!["MEMBER".into()],
            vec![],
        )
        .await,
        t_unlinked: token_for(
            pool,
            priv_pem,
            pub_pem,
            org_a,
            u_unlinked,
            vec!["MEMBER".into()],
            vec![],
        )
        .await,
        t_b: token_for(
            pool,
            priv_pem,
            pub_pem,
            org_b,
            u_b,
            vec!["MEMBER".into()],
            vec![branch_b],
        )
        .await,
    }
}
