// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Department readiness and the governed all-matching remedy use the same population.
mod common;
use common::*;
use console_hr_adapter_postgres::HrService;
use console_kernel_core::BranchScope;
use console_platform_authz::{Principal, Role};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn department_complete(owner: PgPool) {
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
    let mut ids = Vec::new();
    for (n, name, unit, status) in [
        (1, "A", Some(dept), "ACTIVE"),
        (2, "B", Some(site), "ACTIVE"),
        (3, "C", None, "ACTIVE"),
        (4, "D", None, "PRE_HIRE"),
        (5, "E", Some(dissolved), "ACTIVE"),
        (6, "F", None, "ACTIVE"),
    ] {
        let id: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,name,company,position,org_unit_id,employment_status,source_filename,source_sheet,source_row,source_key) VALUES ($1,$2,'Test','대표이사',$3,$4,'fixture.xlsx','Roster',$5,$2) RETURNING id")
            .bind(org).bind(name).bind(unit).bind(status).bind(n).fetch_one(tx.as_mut()).await.unwrap();
        sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,'2020-01-01','MIGRATION',gen_random_uuid())")
            .bind(org).bind(id).bind(entity).bind(workplace).execute(tx.as_mut()).await.unwrap();
        ids.push(id);
    }
    sqlx::query("UPDATE employees SET merged_into_employee_id=$3 WHERE org_id=$1 AND id=$2")
        .bind(org)
        .bind(ids[5])
        .bind(ids[0])
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let hash = publish(&owner, "dept-test", "Test terms", 1).await;
    store
        .accept_terms(&a, "dept-test".into(), hash)
        .await
        .unwrap();
    let p = store.preview(&a).await.unwrap();
    let line = p
        .blockers
        .iter()
        .find(|b| b.code == "people_without_department")
        .expect(
            "staffed people at a site, without a unit, or in a dissolved department must block",
        );
    assert_eq!(line.count, Some(3));
    assert_eq!(
        line.records
            .iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>(),
        ["B", "C", "E"]
    );
    assert_eq!(
        serde_json::to_value(p.facts).unwrap()["people_without_department"],
        3
    );
    assert_eq!(p.facts.org_units, 1);
    let before = snapshot(&owner, &a).await;
    let err = store.go_live(&a, p.digest, false, true).await.unwrap_err();
    assert!(
        matches!(&err,console_onboarding_adapter_postgres::PgOnboardingError::Refused{fields,..} if fields == &["people_without_department"])
    );
    refused(&owner, &a, before, err, "go_live_blocked").await;
    let hr = HrService::new(store.pool().clone());
    let reader = || {
        Principal::new(
            a.user,
            a.org,
            std::collections::BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        )
    };
    let filter = |missing| serde_json::from_value(json!({"department_missing":missing})).unwrap();
    let missing = hr.list_employees(reader(), filter(true)).await.unwrap();
    assert_eq!(missing.total, 3);
    let mut listed = missing.items.iter().map(|e| e.id).collect::<Vec<_>>();
    let mut expected = vec![ids[1], ids[2], ids[4]];
    listed.sort();
    expected.sort();
    assert_eq!(listed, expected);
    assert_eq!(
        hr.list_employees(reader(), filter(false))
            .await
            .unwrap()
            .total,
        3
    );
    let body = |expected_count| {
        serde_json::from_value(json!({
        "event_type":"TRANSFER","to_org_unit_id":dept,
        "effective_date":time::OffsetDateTime::now_utc().to_offset(time::UtcOffset::from_hms(9,0,0).unwrap()).date().to_string(),
        "comment":"Department assignment","signoffs":{"privacy_notice_ack":true,"korean_labor_law_ack":true},
        "selection":{"query":{"department_missing":true},"expected_count":expected_count}
    })).unwrap()
    };
    let err = hr
        .bulk_lifecycle_events(reader(), "dept-stale-count-001".into(), body(2))
        .await
        .unwrap_err();
    assert_eq!(
        (err.status.as_u16(), err.code),
        (409, "bulk_selection_changed")
    );
    let done = hr
        .bulk_lifecycle_events(reader(), "dept-complete-bulk-1".into(), body(3))
        .await
        .unwrap();
    assert_eq!(done["items"].as_array().unwrap().len(), 3);
    let current = store.preview(&a).await.unwrap();
    assert!(current.blockers.is_empty(), "{:?}", current.blockers);
    assert_eq!(
        serde_json::to_value(current.facts).unwrap()["people_without_department"],
        0
    );
    store
        .go_live(&a, current.digest, false, true)
        .await
        .unwrap();
}
