// SPDX-License-Identifier: LicenseRef-Proprietary
//! Batch withdrawal reports live Cedar scope refusals without recording a partial undo.
use console_kernel_core::{Clock, FixedClock, Timestamp};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{fixture, status, uuid};

async fn refuses_outside_scope(pool: PgPool, scheduled: bool) {
    let f = fixture(pool, true).await;
    let mut employees = [f.employee().await, f.employee().await];
    employees.sort();
    let unit = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id,id) VALUES ($1,$2)")
        .bind(f.org)
        .bind(unit)
        .execute(&f.owner)
        .await
        .unwrap();
    sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,$2,1,gen_random_uuid(),$3,decode(repeat('00',32),'hex'),'{\"name\":\"인사부\",\"kind\":\"department\"}','{}')")
        .bind(f.org).bind(unit).bind(f.user).execute(&f.owner).await.unwrap();
    let (entity, workplace) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
        .bind(f.org).bind(entity).execute(&f.owner).await.unwrap();
    sqlx::query("INSERT INTO workplaces (org_id,id,legal_entity_id,needs_confirmation,created_change_mode) VALUES ($1,$2,$3,true,'MIGRATION')")
        .bind(f.org).bind(workplace).bind(entity).execute(&f.owner).await.unwrap();
    sqlx::query("INSERT INTO org_unit_placements (org_id,org_unit_id,legal_entity_id,workplace_id,valid_from,change_mode,command_id) VALUES ($1,$2,$3,$4,'2025-01-02','MIGRATION',gen_random_uuid())")
        .bind(f.org).bind(unit).bind(entity).bind(workplace).execute(&f.owner).await.unwrap();
    sqlx::query("UPDATE employees SET org_unit_id=$2 WHERE id=$1")
        .bind(employees[0])
        .bind(unit)
        .execute(&f.owner)
        .await
        .unwrap();
    let batch =
        f.hr.bulk_lifecycle_events(
            f.ops.clone(),
            Uuid::new_v4().to_string(),
            serde_json::from_value(json!({"event_type":"PROMOTE","employee_ids":employees,
            "effective_date": if scheduled { "2027-03-01" } else { "2026-10-20" },
            "to_position":"과장","comment":"일괄 발령 검증"}))
            .unwrap(),
        )
        .await
        .unwrap();
    let batch = uuid(&batch["batch_id"]);
    // Keep the principal's old tenant-wide role: live grants, not that stale role, decide.
    let clock = FixedClock(Timestamp::now_utc());
    let tenant_grant: Uuid = sqlx::query_scalar(
        "UPDATE access_grants SET valid_to=$3 WHERE org_id=$1 AND account_id=$2 RETURNING id",
    )
    .bind(f.org)
    .bind(f.user)
    .bind(clock.now())
    .fetch_one(&f.owner)
    .await
    .unwrap();
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,org_unit_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) SELECT org_id,account_id,role_id,'DEPARTMENT',$2,valid_from,effective_in_setup,change_mode,reason_code,granted_by FROM access_grants WHERE id=$1")
        .bind(tenant_grant).bind(unit).execute(&f.owner).await.unwrap();
    let snapshot = || async {
        let events: Value = sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM employee_lifecycle_events e WHERE org_id=$1")
            .bind(f.org).fetch_one(&f.owner).await.unwrap();
        let people: Value = sqlx::query_scalar(
            "SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM employees e WHERE org_id=$1",
        )
        .bind(f.org)
        .fetch_one(&f.owner)
        .await
        .unwrap();
        (
            events,
            people,
            f.audits("employee.lifecycle.bulk_rescind").await,
        )
    };
    let before = snapshot().await;
    let mut read_grant = false;
    for (confirm, readable) in [(false, false), (true, false), (false, true), (true, true)] {
        if readable && !read_grant {
            let role = Uuid::new_v4();
            sqlx::query("INSERT INTO access_roles(org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'명부 읽기','ACTIVE',1,$3)")
                .bind(f.org).bind(role).bind(f.user).execute(&f.owner).await.unwrap();
            sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'명부 읽기','ACTIVE','SETUP',$3)")
                .bind(f.org).bind(role).bind(f.user).execute(&f.owner).await.unwrap();
            sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['view'])")
                .bind(f.org).bind(role).execute(&f.owner).await.unwrap();
            sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) SELECT org_id,account_id,$2,'TENANT',valid_from,effective_in_setup,change_mode,reason_code,granted_by FROM access_grants WHERE id=$1")
                .bind(tenant_grant).bind(role).execute(&f.owner).await.unwrap();
            read_grant = true;
        }
        let error =
            f.hr.rescind_lifecycle_batch(
                f.ops.clone(),
                batch,
                serde_json::from_value(
                    json!({"reason_code":"PLAN_WITHDRAWN","confirm_cascades":confirm}),
                )
                .unwrap(),
            )
            .await
            .unwrap_err();
        assert_eq!(status(&error), (422, "bulk_lifecycle_refused"));
        let refusals = error.refusals.unwrap();
        assert_eq!(refusals.as_array().unwrap().len(), 1, "{refusals}");
        if readable {
            assert_eq!(refusals[0]["employee_id"], json!(employees[1]));
        } else {
            assert_eq!(refusals[0]["count"], 1);
            assert!(!refusals.to_string().contains("employee_id"));
            assert!(!refusals.to_string().contains(&employees[1].to_string()));
        }
        assert_eq!(refusals[0]["code"], "forbidden");
        assert_eq!(
            refusals[0]["message"],
            "lifecycle event permission is required in this scope"
        );
        assert_eq!(snapshot().await, before, "no partial undo or audit");
    }
    // A live tenant grant permits the withdrawal without a legacy role.
    sqlx::query("UPDATE access_grants SET valid_to=NULL WHERE id=$1")
        .bind(tenant_grant)
        .execute(&f.owner)
        .await
        .unwrap();
    let mut granted = f.ops.clone();
    granted.roles.clear();
    let outcomes =
        f.hr.rescind_lifecycle_batch(
            granted,
            batch,
            serde_json::from_value(json!({"reason_code":"PLAN_WITHDRAWN","confirm_cascades":true}))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(outcomes.len(), 2);
    assert!(outcomes.iter().all(|o| o.rescinded.is_some()));
    assert_eq!(f.audits("employee.lifecycle.bulk_rescind").await, 1);
}

async fn refuses_without_lifecycle_grant(pool: PgPool, scheduled: bool) {
    let f = fixture(pool, true).await;
    let employees = [f.employee().await, f.employee().await];
    let batch =
        f.hr.bulk_lifecycle_events(
            f.ops.clone(),
            Uuid::new_v4().to_string(),
            serde_json::from_value(json!({"event_type":"PROMOTE","employee_ids":employees,
            "effective_date": if scheduled { "2027-03-01" } else { "2026-10-20" },
            "to_position":"과장","comment":"일괄 발령 검증"}))
            .unwrap(),
        )
        .await
        .unwrap();
    let batch = uuid(&batch["batch_id"]);
    let clock = FixedClock(Timestamp::now_utc());
    sqlx::query("UPDATE access_grants SET valid_to=$3 WHERE org_id=$1 AND account_id=$2")
        .bind(f.org)
        .bind(f.user)
        .bind(clock.now())
        .execute(&f.owner)
        .await
        .unwrap();
    let before: Value = sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM employee_lifecycle_events e WHERE org_id=$1")
        .bind(f.org).fetch_one(&f.owner).await.unwrap();
    let people: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM employees e WHERE org_id=$1",
    )
    .bind(f.org)
    .fetch_one(&f.owner)
    .await
    .unwrap();
    let audits = f.count("audit_events").await;
    let mut expected = None;
    for confirm in [false, true] {
        for batch_id in [batch, Uuid::new_v4()] {
            for reason in ["PLAN_WITHDRAWN", "NOT_A_CODE"] {
                let error =
                    f.hr.rescind_lifecycle_batch(
                        f.ops.clone(),
                        batch_id,
                        serde_json::from_value(
                            json!({"reason_code":reason,"confirm_cascades":confirm}),
                        )
                        .unwrap(),
                    )
                    .await
                    .unwrap_err();
                assert_eq!(status(&error), (403, "forbidden"));
                assert!(error.refusals.is_none());
                assert!(error.errors.is_none());
                let body = json!({"code":error.code,"message":error.message});
                let text = body.to_string();
                assert!(!text.contains("employee_id"));
                for employee in employees {
                    assert!(!text.contains(&employee.to_string()));
                }
                if let Some(expected) = &expected {
                    assert_eq!(
                        &body, expected,
                        "real, missing and invalid-reason batches are indistinguishable"
                    );
                } else {
                    expected = Some(body);
                }
            }
        }
    }
    let after: Value = sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM employee_lifecycle_events e WHERE org_id=$1")
        .bind(f.org).fetch_one(&f.owner).await.unwrap();
    let after_people: Value = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM employees e WHERE org_id=$1",
    )
    .bind(f.org)
    .fetch_one(&f.owner)
    .await
    .unwrap();
    assert_eq!(after, before);
    assert_eq!(after_people, people);
    assert_eq!(f.count("audit_events").await, audits);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn applied_batch_hides_membership_and_reason_validation_without_a_grant(pool: PgPool) {
    refuses_without_lifecycle_grant(pool, false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_batch_hides_membership_and_reason_validation_without_a_grant(pool: PgPool) {
    refuses_without_lifecycle_grant(pool, true).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn applied_batch_refuses_each_person_outside_live_cedar_scope(pool: PgPool) {
    refuses_outside_scope(pool, false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_batch_refuses_each_person_outside_live_cedar_scope(pool: PgPool) {
    refuses_outside_scope(pool, true).await;
}
