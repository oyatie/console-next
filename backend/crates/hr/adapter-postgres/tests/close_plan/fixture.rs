//! The 사업장 every close_plan case closes: 부산지점 of 주식회사 가나, with
//! 개발팀 › 품질팀 and 물류팀 under it and one person placed directly; 본사
//! has 인사팀. Four people, each placed at 부산지점, the tenant past 운영 시작.

use console_entity_application::OrgSetupOp;
use console_hr_adapter_postgres::lifecycle::close_plan::Planner;
use console_hr_adapter_postgres::lifecycle::close_plan::types::{
    CloseJob, WorkplaceClosePlanRequest,
};
use console_hr_adapter_postgres::{HrError, HrService};
use std::collections::BTreeSet;

use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::{Principal, Role};
use serde_json::Value;
use sqlx::PgPool;
use time::{Date, OffsetDateTime, UtcOffset};
use uuid::Uuid;

use crate::close_support::{ORG, World, world};
use crate::common::{cmd, person, port, set_operating, under_ref, under_workplace};

pub fn today() -> Date {
    OffsetDateTime::now_utc()
        .to_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
        .date()
}

pub struct Site {
    pub w: World,
    pub hr: HrService,
    pub hq_unit: Uuid,
    pub branch_unit: Uuid,
    pub dev: Uuid,
    pub qa: Uuid,
    pub logistics: Uuid,
    pub hr_team: Uuid,
    pub kim: Uuid,
    pub lee: Uuid,
    pub park: Uuid,
    pub choi: Uuid,
}

async fn site_unit(owner: &PgPool, workplace: Uuid) -> Uuid {
    sqlx::query_scalar("SELECT org_unit_id FROM org_unit_placements WHERE workplace_id = $1 AND represents_workplace AND valid_to IS NULL")
        .bind(workplace)
        .fetch_one(owner)
        .await
        .unwrap()
}

async fn units(w: &World, ops: Vec<OrgSetupOp>) -> Vec<Uuid> {
    w.store
        .apply_org_setup_batch(&cmd(&w.actor), ops, port())
        .await
        .unwrap()
        .units
        .iter()
        .map(|u| u.org_unit_id)
        .collect()
}

impl Site {
    pub async fn new(owner: &PgPool) -> Self {
        let w = world(owner).await;
        let (hq_unit, branch_unit) = (
            site_unit(owner, w.hq).await,
            site_unit(owner, w.branch).await,
        );
        let b = units(
            &w,
            vec![
                under_workplace("dev", "개발팀", w.branch),
                under_ref("qa", "품질팀", "dev"),
                under_workplace("lg", "물류팀", w.branch),
            ],
        )
        .await;
        let h = units(&w, vec![under_workplace("hr", "인사팀", w.hq)]).await;
        let at = |unit| (w.entity, w.branch, unit);
        let kim = person(owner, &w.store, &w.actor, at(b[0]), "kim").await;
        let lee = person(owner, &w.store, &w.actor, at(b[1]), "lee").await;
        let park = person(owner, &w.store, &w.actor, at(branch_unit), "park").await;
        let choi = person(owner, &w.store, &w.actor, at(b[2]), "choi").await;
        set_operating(owner, ORG).await;
        let hr = HrService::new(w.store.pool().clone());
        Self {
            w,
            hr,
            hq_unit,
            branch_unit,
            dev: b[0],
            qa: b[1],
            logistics: b[2],
            hr_team: h[0],
            kim,
            lee,
            park,
            choi,
        }
    }

    pub fn planner(&self, key: Uuid) -> Planner {
        let principal = Principal::new(
            self.w.actor.user,
            OrgId::from_uuid(ORG),
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        Planner {
            org: OrgId::from_uuid(ORG),
            user: self.w.actor.user,
            command: key,
            principal,
        }
    }

    pub async fn plan_with(&self, key: Uuid, body: Value) -> Result<CloseJob, HrError> {
        let body: WorkplaceClosePlanRequest = serde_json::from_value(body).unwrap();
        self.hr
            .plan_workplace_close(self.planner(key), self.w.branch, body, port())
            .await
    }

    pub async fn plan(&self, body: Value) -> Result<CloseJob, HrError> {
        self.plan_with(Uuid::new_v4(), body).await
    }

    pub async fn tick(&self, today: Date) -> usize {
        self.hr
            .advance_due_workplace_closes(today, port())
            .await
            .unwrap()
    }
}

pub async fn scalar(owner: &PgPool, sql: &'static str, id: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(owner)
        .await
        .unwrap()
}

pub async fn audits(owner: &PgPool, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action = $1")
        .bind(action)
        .fetch_one(owner)
        .await
        .unwrap()
}

pub async fn state(owner: &PgPool, job: Uuid) -> String {
    sqlx::query_scalar("SELECT state FROM workplace_close_jobs WHERE id = $1")
        .bind(job)
        .fetch_one(owner)
        .await
        .unwrap()
}

/// What nothing-written means for a refused plan: no job, no 전근, no exit case, no plan audit.
pub async fn nothing_written(owner: &PgPool) -> (i64, i64, i64, i64) {
    sqlx::query_as(
        "SELECT (SELECT count(*) FROM workplace_close_jobs), (SELECT count(*) FROM employee_lifecycle_events WHERE event_type = 'TRANSFER'), \
                (SELECT count(*) FROM employee_exit_cases), (SELECT count(*) FROM audit_events WHERE action LIKE 'workplace.close%')",
    )
    .fetch_one(owner)
    .await
    .unwrap()
}

/// Their exits took effect (the HR confirmation's TERMINATE, as the owner).
pub async fn exited(owner: &PgPool, people: &[Uuid]) {
    sqlx::query("UPDATE employees SET employment_status = 'EXITED' WHERE id = ANY($1)")
        .bind(people)
        .execute(owner)
        .await
        .unwrap();
}

/// The refusal codes a 422 names, by subject.
pub fn named(e: &HrError) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = e
        .refusals
        .as_deref()
        .and_then(Value::as_array)
        .map(|rs| {
            rs.iter()
                .map(|r| {
                    let who = r
                        .get("employee_id")
                        .or_else(|| r.get("org_unit_id"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    (
                        who.to_owned(),
                        r["code"].as_str().unwrap_or_default().to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}
