// SPDX-License-Identifier: LicenseRef-Proprietary
//! Wave 2 PostgreSQL proofs: department/person setting overrides, tenant-root
//! overtime basis guard, worker-favorable person override guard, and overtime
//! work-rule attestation date boundary evaluation.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::{AuditRequestContext, OrgId, TraceContext};
use console_platform_db::with_org_conn;
use console_platform_test_support::seed_org_and_super_admin;
use console_settings_adapter_postgres::{
    NewOvertimeAttestation, PgSettingsError, PgSettingsStore, list_attestations,
    record_attestation, resolve_overtime_recognition_on_date_in_tx,
};
use console_settings_application::{Actor, ChangeSetting};
use console_settings_domain::SettingValue;
use serde_json::json;
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn wave2_scoped_overrides_guards_and_overtime_attestation_dates(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "wave2").await;
    let store = PgSettingsStore::new(pool.clone());
    let actor = Actor { org, user };

    let entity_id = Uuid::new_v4();
    let workplace_id = Uuid::new_v4();
    let dept_id = Uuid::new_v4();
    let emp_id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO legal_entities (org_id, id, biz_kind, created_change_mode, created_by)
         VALUES ($1, $2, 'CORPORATION', 'SETUP', $3)",
    )
    .bind(org.as_uuid())
    .bind(entity_id)
    .bind(user.as_uuid())
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO workplaces (org_id, id, legal_entity_id, needs_confirmation, created_change_mode, created_by)
         VALUES ($1, $2, $3, true, 'SETUP', $4)",
    )
    .bind(org.as_uuid())
    .bind(workplace_id)
    .bind(entity_id)
    .bind(user.as_uuid())
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
        .bind(org.as_uuid())
        .bind(dept_id)
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt)
         VALUES ($1, $2, 1, $3, $4, decode(repeat('aa', 32), 'hex'), '{\"name\":\"Assembly\",\"status\":\"active\"}'::jsonb, '{}'::jsonb)",
    )
    .bind(org.as_uuid())
    .bind(dept_id)
    .bind(Uuid::new_v4())
    .bind(user.as_uuid())
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO org_unit_placements (org_id, org_unit_id, legal_entity_id, workplace_id, represents_workplace, valid_from, change_mode, command_id)
         VALUES ($1, $2, $3, $4, false, DATE '2026-01-01', 'MIGRATION', $5)",
    )
    .bind(org.as_uuid())
    .bind(dept_id)
    .bind(entity_id)
    .bind(workplace_id)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO employees (org_id, id, company, name, source_filename, source_sheet, source_row, source_key, raw_row, source_metadata, employee_number, employment_status, hire_date, hire_on, org_unit_id)
         VALUES ($1, $2, 'Wave2 Corp', 'Lee Worker', 'test.xlsx', 'employees', 1, 'W2-001', '{}'::jsonb, '{}'::jsonb, 'W2-001', 'ACTIVE', '2026-01-01', DATE '2026-01-01', $3)",
    )
    .bind(org.as_uuid())
    .bind(emp_id)
    .bind(dept_id)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, actor_id, command_id)
         VALUES ($1, $2, $3, $4, DATE '2026-01-01', 'HIRE', $5, $6)",
    )
    .bind(org.as_uuid())
    .bind(emp_id)
    .bind(entity_id)
    .bind(workplace_id)
    .bind(user.as_uuid())
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();

    // 1. Tenant root refuses "recorded" for attendance.overtime_recognition.
    let root_err = store
        .change_setting(
            actor,
            ChangeSetting {
                key: "attendance.overtime_recognition".into(),
                scope_entity_id: None,
                value: json!("recorded"),
                effective_from: None,
                reason_code: "POLICY_REVIEW".into(),
                reason_note: None,
                step_up_assertion_id: None,
                expected_version: None,
            },
            (TraceContext::generate(), AuditRequestContext::default()),
            |_| Ok(()),
        )
        .await
        .unwrap_err();
    match root_err {
        PgSettingsError::Domain(e) => assert_eq!(e.code, Some("setting_tenant_root_disallowed")),
        other => panic!("unexpected error: {other:?}"),
    }

    // 2. Department override to 18 months on hr.fixed_term_limit_months succeeds,
    //    and an individual person override to 20 months (> 18, disfavorable) is refused.
    store
        .change_setting(
            actor,
            ChangeSetting {
                key: "hr.fixed_term_limit_months".into(),
                scope_entity_id: Some(dept_id),
                value: json!(18),
                effective_from: None,
                reason_code: "POLICY_REVIEW".into(),
                reason_note: None,
                step_up_assertion_id: None,
                expected_version: None,
            },
            (TraceContext::generate(), AuditRequestContext::default()),
            |_| Ok(()),
        )
        .await
        .unwrap();

    let person_bad = store
        .change_setting(
            actor,
            ChangeSetting {
                key: "hr.fixed_term_limit_months".into(),
                scope_entity_id: Some(emp_id),
                value: json!(20),
                effective_from: None,
                reason_code: "POLICY_REVIEW".into(),
                reason_note: None,
                step_up_assertion_id: None,
                expected_version: None,
            },
            (TraceContext::generate(), AuditRequestContext::default()),
            |_| Ok(()),
        )
        .await
        .unwrap_err();
    match person_bad {
        PgSettingsError::Domain(e) => assert_eq!(e.code, Some("setting_person_disfavorable")),
        other => panic!("unexpected error: {other:?}"),
    }

    // Worker-favorable person override (12 months < 18 months) succeeds and resolves for emp_id.
    store
        .change_setting(
            actor,
            ChangeSetting {
                key: "hr.fixed_term_limit_months".into(),
                scope_entity_id: Some(emp_id),
                value: json!(12),
                effective_from: None,
                reason_code: "POLICY_REVIEW".into(),
                reason_note: None,
                step_up_assertion_id: None,
                expected_version: None,
            },
            (TraceContext::generate(), AuditRequestContext::default()),
            |_| Ok(()),
        )
        .await
        .unwrap();

    let effective = store.list_live_effective(org, Some(emp_id)).await.unwrap();
    let ft = effective
        .items
        .iter()
        .find(|i| i.key.as_str() == "hr.fixed_term_limit_months")
        .unwrap();
    assert_eq!(ft.value, Some(SettingValue::Int(12)));

    // 3. Overtime recognition attestation date switching:
    //    Before attestation -> "recorded"; after recording confirmed_on = 2026-10-15:
    //    2026-10-15 -> "recorded", 2026-10-16 -> "approval".
    let before = with_org_conn::<_, _, console_platform_db::DbError>(&pool, org, move |tx| {
        Box::pin(async move {
            let now = sqlx::query_scalar("SELECT clock_timestamp()")
                .fetch_one(tx.as_mut())
                .await?;
            Ok(resolve_overtime_recognition_on_date_in_tx(
                tx.as_mut(),
                org,
                Some(emp_id),
                date!(2026 - 10 - 15),
                now,
            )
            .await
            .unwrap())
        })
    })
    .await
    .unwrap();
    assert_eq!(before, "recorded");

    record_attestation(
        &pool,
        org,
        user,
        NewOvertimeAttestation {
            scope_entity_id: Some(workplace_id),
            confirmed_on: date!(2026 - 10 - 15),
            rule_reference: "Work Rules Art. 32".into(),
            worker_notice_method: "Intranet notice and briefing".into(),
            statutory_basis: None,
        },
        (TraceContext::generate(), AuditRequestContext::default()),
    )
    .await
    .unwrap();

    let att_list = list_attestations(&pool, org, Some(emp_id)).await.unwrap();
    assert_eq!(att_list.len(), 1);
    assert_eq!(att_list[0].confirmed_on, "2026-10-15");

    let (on_confirm_day, next_day) =
        with_org_conn::<_, _, console_platform_db::DbError>(&pool, org, move |tx| {
            Box::pin(async move {
                let now = sqlx::query_scalar("SELECT clock_timestamp()")
                    .fetch_one(tx.as_mut())
                    .await?;
                let d1 = resolve_overtime_recognition_on_date_in_tx(
                    tx.as_mut(),
                    org,
                    Some(emp_id),
                    date!(2026 - 10 - 15),
                    now,
                )
                .await
                .unwrap();
                let d2 = resolve_overtime_recognition_on_date_in_tx(
                    tx.as_mut(),
                    org,
                    Some(emp_id),
                    date!(2026 - 10 - 16),
                    now,
                )
                .await
                .unwrap();
                Ok((d1, d2))
            })
        })
        .await
        .unwrap();
    assert_eq!(on_confirm_day, "recorded");
    assert_eq!(next_day, "approval");
}
