//! HR receipt reads mirror the domain's current read gates and pay masking.
use console_kernel_core::{BranchId, BranchScope};
use console_platform_authz::{
    Action, Feature, Principal, authorize, authorize_capability, authorize_org_wide,
};
use console_platform_db::{DbError, with_org_conn};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::collections::BTreeMap;
use uuid::Uuid;

pub(super) fn handles(kind: &str) -> bool {
    matches!(
        kind,
        "employee_exit_case"
            | "employee_lifecycle_bulk_job"
            | "appointment_notice"
            | "employee_correction_batch"
    )
}

pub(super) async fn may_read(pool: &PgPool, p: &Principal, kind: &str, id: &str) -> bool {
    let Ok(id) = Uuid::parse_str(id) else {
        return false;
    };
    let (feature, sql) = match kind {
        "employee_exit_case" => (
            Feature::EmployeeDirectoryRead,
            "SELECT branch_id FROM employee_exit_cases WHERE org_id=$1 AND id=$2",
        ),
        "employee_lifecycle_bulk_job" => (
            Feature::EmployeeDirectoryManage,
            "SELECT NULL::uuid FROM employee_lifecycle_bulk_jobs WHERE org_id=$1 AND id=$2",
        ),
        "appointment_notice" => (
            Feature::EmployeeDirectoryRead,
            "SELECT NULL::uuid FROM appointment_notices WHERE org_id=$1 AND id=$2",
        ),
        "employee_correction_batch" => (
            Feature::EmployeeDirectoryManage,
            "SELECT NULL::uuid FROM employee_correction_batches WHERE org_id=$1 AND id=$2",
        ),
        _ => return false,
    };
    let (p, scoped) = (p.clone(), kind == "employee_exit_case");
    with_org_conn::<_, _, DbError>(pool, p.org_id, move |tx| {
        Box::pin(async move {
            let action = Action::new(feature);
            let allowed = if scoped && p.branch_scope != BranchScope::All {
                authorize_capability(&p, action).is_ok()
            } else {
                authorize_org_wide(&p, action).is_ok()
            };
            if !allowed {
                return Ok(false);
            }
            let Some(branch) = sqlx::query_scalar::<_, Option<Uuid>>(sqlx::AssertSqlSafe(sql))
                .bind(p.org_id.as_uuid())
                .bind(id)
                .fetch_optional(tx.as_mut())
                .await?
            else {
                return Ok(false);
            };
            let readable = match (scoped, &p.branch_scope, branch) {
                (true, BranchScope::Branches(branches), Some(branch)) => {
                    branches.contains(&BranchId::from_uuid(branch))
                }
                (true, BranchScope::Branches(_), None) => false,
                _ => true,
            };
            Ok(
                console_platform_authz::cedar_pbac::actions::command_outcome::decide(
                    &p.user_id.to_string(),
                    &p.org_id.to_string(),
                    false,
                    readable,
                )
                .unwrap_or(false),
            )
        })
    })
    .await
    .unwrap_or(false)
}

fn case_id(fields: &Map<String, Value>) -> Option<Uuid> {
    fields.get("employee_id")?;
    fields.get("effective_exit_date")?;
    fields.get("site_manager_note")?;
    Some(
        fields
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| Uuid::parse_str(id).ok())
            .unwrap_or(Uuid::nil()),
    )
}

fn cases(value: &Value, ids: &mut BTreeMap<Uuid, bool>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| cases(item, ids)),
        Value::Object(fields) => {
            if let Some(id) = case_id(fields) {
                ids.insert(id, false);
            }
            fields.values().for_each(|value| cases(value, ids));
        }
        _ => {}
    }
}

pub(super) async fn mask_exit_results(pool: &PgPool, p: &Principal, result: &mut Value) {
    let mut ids = BTreeMap::new();
    cases(result, &mut ids);
    if ids.is_empty() {
        return;
    }
    let (p, keys) = (p.clone(), ids.clone());
    let allowed = with_org_conn::<_, _, DbError>(pool, p.org_id, move |tx| {
        Box::pin(async move {
            let rows: Vec<(Uuid, Option<Uuid>)> = sqlx::query_as(
                "SELECT id,branch_id FROM employee_exit_cases WHERE org_id=$1 AND id=ANY($2)",
            )
            .bind(p.org_id.as_uuid())
            .bind(keys.keys().copied().collect::<Vec<_>>())
            .fetch_all(tx.as_mut())
            .await?;
            let mut allowed = keys;
            for (id, branch) in rows {
                let action = Action::new(Feature::ExitSettlementManage);
                let decision = match branch {
                    Some(branch) => authorize(&p, action, BranchId::from_uuid(branch)),
                    None => authorize_org_wide(&p, action),
                };
                allowed.insert(id, decision.is_ok());
            }
            Ok(allowed)
        })
    })
    .await
    .unwrap_or(ids);
    mask(result, &allowed);
}

fn mask(value: &mut Value, allowed: &BTreeMap<Uuid, bool>) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(|item| mask(item, allowed)),
        Value::Object(fields) => {
            if case_id(fields).is_some_and(|id| !allowed.get(&id).copied().unwrap_or(false))
                && let Some(Value::Object(package)) = fields.get_mut("settlement_package")
            {
                for key in [
                    "average_wage_total_won",
                    "average_daily_wage_milliwon",
                    "severance_pay_won",
                    "monthly_ordinary_wage_won",
                    "ordinary_daily_wage_won",
                    "statutory_daily_wage_milliwon",
                ] {
                    package.remove(key);
                }
                let marker = json!({"certification_status":package.get("certification_status").cloned().unwrap_or(Value::Null)});
                package.insert("statutory_basis".into(), json!({}));
                package.insert("insurance_loss_payload".into(), marker.clone());
                package.insert("approval_payload".into(), marker);
                package.insert("figures_withheld".into(), Value::Bool(true));
            }
            fields.values_mut().for_each(|value| mask(value, allowed));
        }
        _ => {}
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::super::{access_tests::Fixture, mask_saved_result, may_read};
    use super::*;
    use console_platform_authz::{EffectiveFeatureGrant, PermissionLevel};
    use console_platform_test_support::MIGRATOR;
    use std::collections::BTreeSet;

    fn granted(f: &Fixture, feature: Feature, scope: BranchScope) -> Principal {
        let grant = EffectiveFeatureGrant::new(feature, PermissionLevel::Allow, scope.clone());
        f.principal(scope)
            .with_effective_feature_grants(vec![grant])
    }
    async fn reads(f: &Fixture, p: &Principal, kind: &str, id: &str) -> bool {
        may_read(&f.rt, p, kind, id, Some(*f.branches[0].as_uuid())).await
    }
    async fn exit(f: &Fixture, branch: Option<Uuid>) -> Uuid {
        let employee = f.employee(f.branches[0]).await;
        sqlx::query_scalar("INSERT INTO employee_exit_cases (org_id,employee_id,branch_id,effective_exit_date,site_manager_note,reported_by) VALUES ($1,$2,$3,'2026-10-09','Report',$4) RETURNING id")
            .bind(f.org.as_uuid()).bind(employee).bind(branch).bind(f.actor.as_uuid()).fetch_one(&f.owner).await.unwrap() // rls-arming: ok owner fixture
    }
    #[sqlx::test(migrator = "MIGRATOR")]
    async fn exit_receipts_use_current_case_scope_and_mask_pay_on_grant_loss(pool: PgPool) {
        let f = Fixture::new(pool.clone()).await;
        let foreign = Fixture::new(pool).await;
        let id = exit(&f, Some(*f.branches[0].as_uuid())).await;
        let outside = exit(&f, Some(*f.branches[1].as_uuid())).await;
        let branchless = exit(&f, None).await;
        let other = exit(&foreign, Some(*foreign.branches[0].as_uuid())).await;
        let scope = BranchScope::Branches(BTreeSet::from([f.branches[0]]));
        let p = granted(&f, Feature::EmployeeDirectoryRead, scope.clone());
        assert!(
            may_read(
                &f.rt,
                &p,
                "employee_exit_case",
                &id.to_string(),
                Some(*f.branches[1].as_uuid())
            )
            .await
        );
        let kind = "employee_exit_case";
        for denied in [
            outside.to_string(),
            branchless.to_string(),
            other.to_string(),
            Uuid::new_v4().to_string(),
            "bad-id".into(),
        ] {
            assert!(!reads(&f, &p, kind, &denied).await);
        }
        assert!(!reads(&f, &f.principal(scope.clone()), kind, &id.to_string()).await);
        let wide = granted(&f, Feature::EmployeeDirectoryRead, BranchScope::All);
        assert!(reads(&f, &wide, kind, &branchless.to_string()).await);
        let package = json!({"service_days":10,"average_wage_total_won":1,"average_daily_wage_milliwon":2,"severance_pay_won":3,"monthly_ordinary_wage_won":4,"ordinary_daily_wage_won":5,"statutory_daily_wage_milliwon":6,"statutory_basis":{"private":true},"insurance_loss_payload":{"private":true},"approval_payload":{"private":true},"certification_status":"CERTIFIED"});
        let original = json!({"id":id,"employee_id":Uuid::new_v4(),"effective_exit_date":"2026-10-09","site_manager_note":"Public","branch_id":f.branches[1],"settlement_package":package});
        let mut result = original.clone();
        let manager = granted(&f, Feature::ExitSettlementManage, scope);
        mask_saved_result(&f.rt, &manager, &mut result).await;
        assert_eq!(result, original);
        mask_saved_result(&f.rt, &p, &mut result).await;
        let pay = &result["settlement_package"];
        assert_eq!(
            pay,
            &json!({"service_days":10,"statutory_basis":{},"insurance_loss_payload":{"certification_status":"CERTIFIED"},"approval_payload":{"certification_status":"CERTIFIED"},"certification_status":"CERTIFIED","figures_withheld":true})
        );
        sqlx::query("UPDATE employee_exit_cases SET branch_id=$3 WHERE org_id=$1 AND id=$2")
            .bind(f.org.as_uuid())
            .bind(id)
            .bind(f.branches[1].as_uuid())
            .execute(&f.owner)
            .await
            .unwrap(); // rls-arming: ok owner fixture
        assert!(!reads(&f, &p, kind, &id.to_string()).await);
        result = original;
        mask_saved_result(&f.rt, &manager, &mut result).await;
        assert_eq!(result["settlement_package"]["figures_withheld"], true);
    }

    async fn heads(f: &Fixture) -> [Uuid; 2] {
        let job = sqlx::query_scalar("INSERT INTO employee_lifecycle_bulk_jobs (org_id,idempotency_key,request_fingerprint,request,requested_by) VALUES ($1,$2,$3,'{}',$4) RETURNING id")
            .bind(f.org.as_uuid()).bind(Uuid::new_v4().to_string()).bind("a".repeat(64)).bind(f.actor.as_uuid()).fetch_one(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
        let notice = sqlx::query_scalar("INSERT INTO appointment_notices (org_id,notice_year,seq,notice_no,title,notice_date,issued_by) VALUES ($1,2026,1,'2026-0001','Notice','2026-10-09',$2) RETURNING id")
            .bind(f.org.as_uuid()).bind(f.actor.as_uuid()).fetch_one(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
        [job, notice]
    }
    #[sqlx::test(migrator = "MIGRATOR")]
    async fn job_and_notice_receipts_require_existing_tenant_heads_and_the_actual_read_feature(
        pool: PgPool,
    ) {
        let f = Fixture::new(pool.clone()).await;
        let foreign = Fixture::new(pool).await;
        let ids = heads(&f).await;
        let others = heads(&foreign).await;
        for (index, kind) in ["employee_lifecycle_bulk_job", "appointment_notice"]
            .iter()
            .enumerate()
        {
            let features = [
                Feature::EmployeeDirectoryManage,
                Feature::EmployeeDirectoryRead,
            ];
            let (feature, wrong) = (features[index], features[1 - index]);
            let p = granted(&f, feature, BranchScope::All);
            assert!(reads(&f, &p, kind, &ids[index].to_string()).await);
            let scoped = granted(
                &f,
                feature,
                BranchScope::Branches(BTreeSet::from([f.branches[0]])),
            );
            let wrong = granted(&f, wrong, BranchScope::All);
            for denied in [&scoped, &wrong, &f.principal(BranchScope::All)] {
                assert!(!reads(&f, denied, kind, &ids[index].to_string()).await);
            }
            for id in [
                others[index].to_string(),
                Uuid::new_v4().to_string(),
                "bad-id".into(),
            ] {
                assert!(!reads(&f, &p, kind, &id).await);
            }
            assert!(!reads(&f, &p, "command_outcome", &ids[index].to_string()).await);
        }
    }
}
