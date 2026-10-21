//! Settlement outcome reads follow the current work-order branch.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::super::{access_tests::Fixture, may_read};
use super::tests::granted;
use console_kernel_core::BranchScope;
use console_platform_authz::Feature;
use console_platform_test_support::MIGRATOR;
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;
async fn settlement(f: &Fixture) -> (Uuid, Uuid) {
    sqlx::query_as("WITH customer AS (INSERT INTO registry_customers (org_id,branch_id,name) VALUES ($1,$2,'Customer') RETURNING id),
            site AS (INSERT INTO registry_sites (org_id,branch_id,customer_id,name) SELECT $1,$2,id,'Site' FROM customer RETURNING id,customer_id),
            equipment AS (INSERT INTO registry_equipment (org_id,branch_id,customer_id,site_id,equipment_no,manufacturer_code,kind_code,power_code,status,specification,ton_text,source_sheet,source_row) SELECT $1,$2,customer_id,id,'TSTXX-0001','TEST','TEST','TEST','예비','Test','1','Fixture',1 FROM site RETURNING id,customer_id,site_id),
            work AS (INSERT INTO work_orders (org_id,branch_id,equipment_id,customer_id,site_id,requested_by,request_no,status,symptom) SELECT $1,$2,id,customer_id,site_id,$3,'20261009-001','REPORT_SUBMITTED','Test' FROM equipment RETURNING id)
            INSERT INTO work_order_settlements (org_id,work_order_id,branch_id,idempotency_key,request_hash,created_by) SELECT $1,id,$2,$4,'hash',$3 FROM work RETURNING id,work_order_id")
            .bind(f.org.as_uuid()).bind(f.branches[0].as_uuid()).bind(f.actor.as_uuid())
            .bind(Uuid::new_v4().to_string()).fetch_one(&f.owner).await.unwrap() // rls-arming: ok owner fixture
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn settlement_read_uses_existing_tenant_order_and_current_branch(pool: PgPool) {
    let f = Fixture::new(pool.clone()).await;
    let foreign = Fixture::new(pool).await;
    let (id, order) = settlement(&f).await;
    let (other, _) = settlement(&foreign).await;
    let scope = BranchScope::Branches(BTreeSet::from([f.branches[0]]));
    let p = granted(&f, Feature::WorkOrderReadAll, scope.clone());
    let kind = "work_order_settlement";
    assert!(
        may_read(
            &f.rt,
            &p,
            kind,
            &id.to_string(),
            Some(*f.branches[1].as_uuid())
        )
        .await
    );
    let lost = f.principal(scope.clone());
    let writer = granted(&f, Feature::WorkReportSubmit, scope);
    let outside = granted(
        &f,
        Feature::WorkOrderReadAll,
        BranchScope::Branches(BTreeSet::from([f.branches[1]])),
    );
    for denied in [&lost, &writer, &outside] {
        assert!(
            !may_read(
                &f.rt,
                denied,
                kind,
                &id.to_string(),
                Some(*f.branches[0].as_uuid())
            )
            .await
        );
    }
    for target in [
        other.to_string(),
        Uuid::new_v4().to_string(),
        "bad-id".into(),
    ] {
        assert!(!may_read(&f.rt, &p, kind, &target, None).await);
    }
    sqlx::query("UPDATE work_orders SET branch_id=$3 WHERE org_id=$1 AND id=$2")
        .bind(f.org.as_uuid())
        .bind(order)
        .bind(f.branches[1].as_uuid())
        .execute(&f.owner)
        .await
        .unwrap(); // rls-arming: ok owner fixture
    assert!(
        !may_read(
            &f.rt,
            &p,
            kind,
            &id.to_string(),
            Some(*f.branches[0].as_uuid())
        )
        .await
    );
    assert!(may_read(&f.rt, &outside, kind, &id.to_string(), None).await);
}
