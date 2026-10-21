//! Existing domain read gates, resolved against the record's current ownership.
use console_kernel_core::{BranchId, BranchScope};
use console_platform_authz::{
    Action, Feature, Principal, authorize, authorize_capability, authorize_org_wide,
};
use console_platform_db::DbError;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub(super) async fn may_read(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    kind: &str,
    id: Uuid,
) -> Result<bool, DbError> {
    let org = p.org_id.as_uuid();
    let exists_sql = match kind {
        "period_lock" => {
            Some("SELECT EXISTS (SELECT 1 FROM period_locks WHERE org_id=$1 AND id=$2)")
        }
        "org_change_request" => {
            Some("SELECT EXISTS (SELECT 1 FROM org_change_requests WHERE org_id=$1 AND id=$2)")
        }
        _ => None,
    };
    if let Some(sql) = exists_sql {
        let exists: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
            .bind(org)
            .bind(id)
            .fetch_one(tx.as_mut())
            .await?;
        return Ok(exists
            && match kind {
                "period_lock" => {
                    authorize_org_wide(p, Action::new(Feature::PeriodLockManage)).is_ok()
                }
                "org_change_request" => {
                    authorize_capability(p, Action::new(Feature::OrgChangeRead)).is_ok()
                }
                _ => false,
            });
    }
    let branch_sql = match kind {
        "equipment_3r_unit" => "SELECT branch_id FROM equipment_3r_units WHERE org_id=$1 AND id=$2",
        "equipment_3r_case" => {
            "SELECT branch_id FROM equipment_3r_rental_cases WHERE org_id=$1 AND id=$2"
        }
        "equipment_3r_disposition" => {
            "SELECT branch_id FROM equipment_3r_dispositions WHERE org_id=$1 AND id=$2"
        }
        "work_order_settlement" => {
            "SELECT w.branch_id FROM work_order_settlements s JOIN work_orders w ON w.org_id=s.org_id AND w.id=s.work_order_id WHERE s.org_id=$1 AND s.id=$2"
        }
        _ => return Ok(false),
    };
    let Some(branch) = sqlx::query_scalar::<_, Uuid>(sqlx::AssertSqlSafe(branch_sql))
        .bind(org)
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?
    else {
        return Ok(false);
    };
    if kind == "work_order_settlement" {
        return Ok(authorize(
            p,
            Action::new(Feature::WorkOrderReadAll),
            BranchId::from_uuid(branch),
        )
        .is_ok());
    }
    let action = Action::new(Feature::Equipment3rObserve);
    Ok(match p.branch_scope {
        BranchScope::All => authorize_org_wide(p, action),
        _ => authorize(p, action, BranchId::from_uuid(branch)),
    }
    .is_ok())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::super::{access_tests::Fixture, may_read};
    use console_kernel_core::{BranchId, BranchScope};
    use console_platform_authz::{
        EffectiveFeatureGrant, Feature, PermissionLevel, Principal, Role,
    };
    use console_platform_test_support::MIGRATOR;
    use sqlx::PgPool;
    use std::collections::BTreeSet;
    use uuid::Uuid;

    const EQUIPMENT_KINDS: [&str; 3] = [
        "equipment_3r_unit",
        "equipment_3r_case",
        "equipment_3r_disposition",
    ];

    async fn equipment(f: &Fixture, branch: BranchId) -> [Uuid; 3] {
        let ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
        sqlx::query("INSERT INTO equipment_3r_units (org_id,id,branch_id,serial_no,model_name,capacity_class,acquisition_cost_minor,created_by) VALUES ($1,$2,$3,$4,'Test unit','2.5t',1,$5)")
            .bind(f.org.as_uuid()).bind(ids[0]).bind(branch.as_uuid()).bind(ids[0].to_string())
            .bind(f.actor.as_uuid()).execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
        sqlx::query("INSERT INTO equipment_3r_rental_cases (org_id,id,branch_id,unit_id,customer_name,site_reference,monthly_rate_minor,duration_months,currency_code,idempotency_key,request_fingerprint,created_by) VALUES ($1,$2,$3,$4,'Customer','Site',1,1,'KRW',$5,$6,$7)")
            .bind(f.org.as_uuid()).bind(ids[1]).bind(branch.as_uuid()).bind(ids[0])
            .bind(ids[1].to_string()).bind("a".repeat(64)).bind(f.actor.as_uuid())
            .execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
        let assessment: Uuid = sqlx::query_scalar("INSERT INTO equipment_3r_return_assessments (org_id,branch_id,case_id,condition_grade,findings,disposition,assessed_by) VALUES ($1,$2,$3,'A','Test','REPAIR',$4) RETURNING id")
            .bind(f.org.as_uuid()).bind(branch.as_uuid()).bind(ids[1]).bind(f.actor.as_uuid())
            .fetch_one(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
        sqlx::query("INSERT INTO equipment_3r_dispositions (org_id,id,branch_id,unit_id,case_id,assessment_id,kind) VALUES ($1,$2,$3,$4,$5,$6,'REPAIR')")
            .bind(f.org.as_uuid()).bind(ids[2]).bind(branch.as_uuid()).bind(ids[0])
            .bind(ids[1]).bind(assessment).execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
        ids
    }

    async fn period(f: &Fixture) -> Uuid {
        sqlx::query_scalar("INSERT INTO period_locks (org_id,domain,period_start,period_end,reason_code,locked_by) VALUES ($1,'payroll','2026-06-01','2026-06-30','MONTHLY_PAYROLL_CLOSE',$2) RETURNING id")
            .bind(f.org.as_uuid()).bind(f.actor.as_uuid()).fetch_one(&f.owner).await.unwrap() // rls-arming: ok owner fixture
    }

    async fn change(f: &Fixture) -> Uuid {
        sqlx::query_scalar("INSERT INTO org_change_requests (org_id,code,kind,target_kind,target_ref,target_label,effective_date,reason,drafted_by,idempotency_key,request_fingerprint) VALUES ($1,'OC-2026-0001','NEW','ENTITY','company','Company','2026-10-09','Test',$2,$3,$4) RETURNING id")
            .bind(f.org.as_uuid()).bind(f.actor.as_uuid()).bind(Uuid::new_v4().to_string())
            .bind("a".repeat(64)).fetch_one(&f.owner).await.unwrap() // rls-arming: ok owner fixture
    }

    pub(super) fn granted(f: &Fixture, feature: Feature, scope: BranchScope) -> Principal {
        f.principal(scope.clone())
            .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
                feature,
                PermissionLevel::Allow,
                scope,
            )])
    }

    #[sqlx::test(migrator = "MIGRATOR")]
    async fn equipment_read_requires_observe_at_the_current_record_branch(pool: PgPool) {
        let f = Fixture::new(pool.clone()).await;
        let foreign = Fixture::new(pool).await;
        let inside = equipment(&f, f.branches[0]).await;
        let outside = equipment(&f, f.branches[1]).await;
        let others = equipment(&foreign, foreign.branches[0]).await;
        let scope = BranchScope::Branches(BTreeSet::from([f.branches[0]]));
        let p = granted(&f, Feature::Equipment3rObserve, scope.clone());
        let lost = f.principal(scope.clone());
        let writer = granted(&f, Feature::Equipment3rQuote, scope.clone());
        let partial = f
            .principal(BranchScope::All)
            .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
                Feature::Equipment3rObserve,
                PermissionLevel::Allow,
                scope,
            )]);
        let wide = granted(&f, Feature::Equipment3rObserve, BranchScope::All);
        for (index, kind) in EQUIPMENT_KINDS.iter().enumerate() {
            assert!(
                may_read(
                    &f.rt,
                    &p,
                    kind,
                    &inside[index].to_string(),
                    Some(*f.branches[1].as_uuid())
                )
                .await
            );
            assert!(may_read(&f.rt, &wide, kind, &outside[index].to_string(), None).await);
            assert!(!may_read(&f.rt, &lost, kind, &inside[index].to_string(), None).await);
            assert!(!may_read(&f.rt, &writer, kind, &inside[index].to_string(), None).await);
            assert!(!may_read(&f.rt, &partial, kind, &inside[index].to_string(), None).await);
            for id in [
                outside[index].to_string(),
                others[index].to_string(),
                Uuid::new_v4().to_string(),
                "bad-id".to_owned(),
            ] {
                assert!(!may_read(&f.rt, &p, kind, &id, Some(*f.branches[0].as_uuid())).await);
            }
        }
        sqlx::query("UPDATE equipment_3r_units SET branch_id=$3 WHERE org_id=$1 AND id=$2")
            .bind(f.org.as_uuid())
            .bind(inside[0])
            .bind(f.branches[1].as_uuid())
            .execute(&f.owner)
            .await
            .unwrap(); // rls-arming: ok owner fixture
        assert!(
            !may_read(
                &f.rt,
                &p,
                EQUIPMENT_KINDS[0],
                &inside[0].to_string(),
                Some(*f.branches[0].as_uuid())
            )
            .await
        );
        assert!(!may_read(&f.rt, &wide, "logistics_asn", &inside[0].to_string(), None).await);
    }

    #[sqlx::test(migrator = "MIGRATOR")]
    async fn period_lock_read_requires_existing_tenant_record_and_org_wide_authority(pool: PgPool) {
        let f = Fixture::new(pool.clone()).await;
        let foreign = Fixture::new(pool).await;
        let lock = period(&f).await;
        let other = period(&foreign).await;
        let p = granted(&f, Feature::PeriodLockManage, BranchScope::All);
        assert!(may_read(&f.rt, &p, "period_lock", &lock.to_string(), None).await);
        let lost = f.principal(BranchScope::All);
        assert!(!may_read(&f.rt, &lost, "period_lock", &lock.to_string(), None).await);
        let scope = BranchScope::Branches(BTreeSet::from([f.branches[0]]));
        let scoped = granted(&f, Feature::PeriodLockManage, scope);
        assert!(
            !may_read(
                &f.rt,
                &scoped,
                "period_lock",
                &lock.to_string(),
                Some(*f.branches[0].as_uuid())
            )
            .await
        );
        for id in [
            other.to_string(),
            Uuid::new_v4().to_string(),
            "bad-id".to_owned(),
        ] {
            assert!(!may_read(&f.rt, &p, "period_lock", &id, None).await);
        }
    }

    #[sqlx::test(migrator = "MIGRATOR")]
    async fn org_change_reader_uses_branchless_capability_without_widening_scope(pool: PgPool) {
        let f = Fixture::new(pool.clone()).await;
        let foreign = Fixture::new(pool).await;
        let id = change(&f).await;
        let other = change(&foreign).await;
        let scope = BranchScope::Branches(BTreeSet::from([f.branches[0]]));
        let admin = Principal::new(
            f.reader,
            f.org,
            BTreeSet::from([Role::Admin]),
            scope.clone(),
        );
        let reader = granted(&f, Feature::OrgChangeRead, scope.clone());
        for p in [&admin, &reader] {
            assert!(may_read(&f.rt, p, "org_change_request", &id.to_string(), None).await);
            for target in [
                other.to_string(),
                Uuid::new_v4().to_string(),
                "bad-id".to_owned(),
            ] {
                assert!(!may_read(&f.rt, p, "org_change_request", &target, None).await);
            }
        }
        let lost = f.principal(scope.clone());
        assert!(!may_read(&f.rt, &lost, "org_change_request", &id.to_string(), None).await);
        let partial = f
            .principal(BranchScope::Branches(BTreeSet::from(f.branches)))
            .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
                Feature::OrgChangeRead,
                PermissionLevel::Allow,
                scope,
            )]);
        assert!(!may_read(&f.rt, &partial, "org_change_request", &id.to_string(), None).await);
        let empty = granted(&f, Feature::OrgChangeRead, BranchScope::none());
        assert!(!may_read(&f.rt, &empty, "org_change_request", &id.to_string(), None).await);
    }
}

#[cfg(test)]
#[path = "observed/settlement_tests.rs"]
mod settlement_tests;
