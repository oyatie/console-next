// SPDX-License-Identifier: LicenseRef-Proprietary
//! Batch withdrawal reports live Cedar scope refusals without recording a partial undo.
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
    let tenant_grant: Uuid = sqlx::query_scalar(
        "UPDATE access_grants SET valid_to=now() WHERE org_id=$1 AND account_id=$2 RETURNING id",
    )
    .bind(f.org)
    .bind(f.user)
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
    for confirm in [false, true] {
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
        assert_eq!(refusals[0]["employee_id"], json!(employees[1]));
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn applied_batch_refuses_each_person_outside_live_cedar_scope(pool: PgPool) {
    refuses_outside_scope(pool, false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_batch_refuses_each_person_outside_live_cedar_scope(pool: PgPool) {
    refuses_outside_scope(pool, true).await;
}
