// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Direct-workplace members supervised by an appointed workplace head satisfy department readiness.
mod common;
use common::*;
use console_hr_adapter_postgres::HrService;
use console_kernel_core::BranchScope;
use console_platform_authz::{Principal, Role};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplace_head_supervises_direct_workplace_members(owner: PgPool) {
    let (store, a) = tenant(&owner).await;
    let org = *a.org.as_uuid();
    let (entity, workplace, dept, site, dissolved) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    // rls-arming: ok owner-only synthetic setup; reads and commands below use console_rt.
    sqlx::query("INSERT INTO legal_entities (org_id,id,primary_workplace_id,biz_kind,needs_confirmation,created_change_mode) VALUES ($1,$2,$3,'CORPORATION',false,'MIGRATION')")
        .bind(org).bind(entity).bind(workplace).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),'2020-01-01','Test','MIGRATION','CREATE',sha256('x'::bytea),'{}')")
        .bind(org).bind(entity).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO workplaces (org_id,id,legal_entity_id,needs_confirmation,default_branch_id,created_change_mode) VALUES ($1,$2,$3,false,gen_random_uuid(),'MIGRATION')")
        .bind(org).bind(workplace).bind(entity).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO workplace_revisions (org_id,workplace_id,version,command_id,effective_from,name,status,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),'2020-01-01','Workplace','CONTINUING','MIGRATION','CREATE',sha256('x'::bytea),'{}')")
        .bind(org).bind(workplace).execute(tx.as_mut()).await.unwrap();
    for (id, kind, status) in [
        (dept, "department", "active"),
        (site, "site", "active"),
        (dissolved, "department", "dissolved"),
    ] {
        sqlx::query("INSERT INTO org_units (org_id,id) VALUES ($1,$2)")
            .bind(org)
            .bind(id)
            .execute(tx.as_mut())
            .await
            .unwrap();
        for (version, kind, status) in [(1, "department", "active"), (2, kind, status)] {
            sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,$2,$3,gen_random_uuid(),$4,sha256('x'::bytea),$5,'{}')")
                .bind(org).bind(id).bind(version).bind(a.user.as_uuid()).bind(json!({"name":id.to_string(),"kind":kind,"status":status})).execute(tx.as_mut()).await.unwrap();
        }
    }
    sqlx::query("INSERT INTO org_unit_placements (org_id,org_unit_id,legal_entity_id,workplace_id,represents_workplace,valid_from,change_mode,actor_id,command_id) VALUES ($1,$2,$3,$4,true,'2020-01-01','MIGRATION',$5,gen_random_uuid())")
        .bind(org).bind(site).bind(entity).bind(workplace).bind(a.user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    let mut ids = Vec::new();
    for (n, name, unit, status) in [
        (1, "A", Some(dept), "ACTIVE"),
        (2, "B", Some(site), "ACTIVE"),
        (3, "C", None, "ACTIVE"),
        (4, "E", Some(dissolved), "ACTIVE"),
    ] {
        let id: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,name,company,position,org_unit_id,employment_status,source_filename,source_sheet,source_row,source_key) VALUES ($1,$2,'Test','Manager',$3,$4,'fixture.xlsx','Roster',$5,$2) RETURNING id")
            .bind(org).bind(name).bind(unit).bind(status).bind(n).fetch_one(tx.as_mut()).await.unwrap();
        sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,'2020-01-01','MIGRATION',gen_random_uuid())")
            .bind(org).bind(id).bind(entity).bind(workplace).execute(tx.as_mut()).await.unwrap();
        ids.push(id);
    }
    tx.commit().await.unwrap();
    sqlx::query("INSERT INTO business_registrations (org_id,legal_entity_id,brn_pending_reason,created_change_mode) VALUES ($1,$2,'NEW_REGISTRATION_PENDING','MIGRATION')")
        .bind(org).bind(entity).execute(&owner).await.unwrap();
    let hash = publish(&owner, "wp-head-test", "Test terms", 1).await;
    store
        .accept_terms(&a, "wp-head-test".into(), hash)
        .await
        .unwrap();

    // Appoint ids[0] as workplace head on console_rt (proving column-scoped UPDATE grant too).
    console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(store.pool(), a.org, |tx| {
        let head = ids[0];
        Box::pin(async move {
            sqlx::query(
                "UPDATE workplaces SET head_employee_id = $2, head_since = entity_today() WHERE id = $1",
            )
            .bind(workplace)
            .bind(head)
            .execute(tx.as_mut())
            .await?;
            Ok(())
        })
    })
    .await
    .unwrap();

    let p = store.preview(&a).await.unwrap();
    let line = p
        .blockers
        .iter()
        .find(|b| b.code == "people_without_department")
        .expect("employee in dissolved department still blocks");
    assert_eq!(line.count, Some(1));
    assert_eq!(
        line.records
            .iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>(),
        ["E"]
    );

    let hr = HrService::new(store.pool().clone());
    let reader = Principal::new(
        a.user,
        a.org,
        std::collections::BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let missing = hr
        .list_employees(
            reader,
            serde_json::from_value(json!({"department_missing": true})).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.total, 1);
    assert_eq!(missing.items[0].id, ids[3]);

    // Clearing the workplace head restores direct-workplace members as blocking.
    console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(
        store.pool(),
        a.org,
        |tx| {
            Box::pin(async move {
                sqlx::query(
                "UPDATE workplaces SET head_employee_id = NULL, head_since = NULL WHERE id = $1",
            )
            .bind(workplace)
            .execute(tx.as_mut())
            .await?;
                Ok(())
            })
        },
    )
    .await
    .unwrap();
    let after_clear = store.preview(&a).await.unwrap();
    let line = after_clear
        .blockers
        .iter()
        .find(|b| b.code == "people_without_department")
        .unwrap();
    assert_eq!(line.count, Some(3));
}
