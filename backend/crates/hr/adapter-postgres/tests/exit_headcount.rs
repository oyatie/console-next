// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Reported dates are 마지막 근무일, shared by live and dated org surfaces.

#[path = "../../../entity/adapter-postgres/tests/common/mod.rs"]
mod common;

use common::{person, set_operating, tenant, two_workplaces};
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::{Actor, OrgStructure, ReadOptions};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::exits::types::{
    ConfirmEmployeeExitCaseRequest, ReportEmployeeExitCaseRequest,
};
use console_kernel_core::BranchScope;
use console_ontology_canonical_adapter_postgres::employment::appoint_legacy_head_in_tx;
use console_platform_authz::{Principal, Role};
use serde_json::json;
use sqlx::PgPool;
use std::collections::BTreeSet;
use time::{Date, Duration};
use uuid::Uuid;

struct World {
    store: PgEntityStore,
    hr: HrService,
    actor: Actor,
    employee: Uuid,
    workplace: Uuid,
    today: Date,
}

async fn world(owner: &PgPool) -> World {
    let (store, actor) = tenant(owner, Uuid::new_v4(), "exit-headcount").await;
    let today: Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(owner)
        .await
        .unwrap();
    let (entity, [(workplace, unit), _]) = two_workplaces(&store, &actor).await;
    let employee = person(owner, &store, &actor, (entity, workplace, unit), "leaver").await;
    sqlx::query("UPDATE employees SET hire_date=$2 WHERE id=$1")
        .bind(employee)
        .bind((today - Duration::days(30)).to_string())
        .execute(owner)
        .await
        .unwrap();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(actor.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    appoint_legacy_head_in_tx(&mut tx, actor.org, actor.user, employee)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    set_operating(owner, *actor.org.as_uuid()).await;
    let hr = HrService::new(store.pool().clone());
    World {
        store,
        hr,
        actor,
        employee,
        workplace,
        today,
    }
}

impl World {
    async fn confirm(&self, last_day: Date) {
        let principal = Principal::new(
            self.actor.user,
            self.actor.org,
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        let report: ReportEmployeeExitCaseRequest = serde_json::from_value(json!({
            "employee_id": self.employee, "effective_exit_date": last_day.to_string(),
            "site_manager_note": "개인 사정으로 퇴직",
        }))
        .unwrap();
        let (_, case) = self
            .hr
            .report_exit_case(principal.clone(), Uuid::new_v4().to_string(), report)
            .await
            .unwrap();
        let id = case["id"].as_str().unwrap().parse().unwrap();
        let confirm: ConfirmEmployeeExitCaseRequest = serde_json::from_value(json!({
            "signoffs": { "privacy_notice_ack": true, "korean_labor_law_ack": true,
                "payroll_cutoff_ack": true, "retirement_settlement_ack": true },
        }))
        .unwrap();
        self.hr
            .confirm_exit_case(principal, None, id, confirm)
            .await
            .unwrap();
    }

    fn count(&self, tree: &OrgStructure) -> i64 {
        tree.entities
            .iter()
            .flat_map(|e| &e.children)
            .find(|w| w.id == self.workplace)
            .unwrap()
            .headcount
    }

    async fn live(&self) -> i64 {
        self.count(&self.store.org_structure(&self.actor).await.unwrap())
    }

    async fn state(&self, owner: &PgPool) -> (String, String, String) {
        sqlx::query_as(
            "SELECT e.employment_status,x.state,x.effective_date FROM employees e \
             JOIN employee_lifecycle_events x ON x.employee_id=e.id WHERE e.id=$1 AND x.event_type='TERMINATE'",
        ).bind(self.employee).fetch_one(owner).await.unwrap()
    }

    async fn boundary(&self, owner: &PgPool, last_day: Date) {
        let cutoff = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(owner)
            .await
            .unwrap();
        for known_at in [None, Some(cutoff)] {
            for (date, expected) in [(last_day, 1), (last_day.next_day().unwrap(), 0)] {
                let options = ReadOptions {
                    as_of: Some(date),
                    known_at,
                };
                let chart = self
                    .store
                    .org_structure_at(&self.actor, options)
                    .await
                    .unwrap();
                assert_eq!(self.count(&chart), expected, "chart at {date}");
                let list = self
                    .store
                    .list_entities_at(&self.actor, false, options)
                    .await
                    .unwrap();
                let listed = list
                    .iter()
                    .flat_map(|e| &e.workplaces)
                    .find(|w| w.id == self.workplace)
                    .unwrap()
                    .headcount;
                assert_eq!(listed, expected, "list at {date}");
                let compare = self
                    .store
                    .structure_diff(&self.actor, last_day.previous_day().unwrap(), date, options)
                    .await
                    .unwrap();
                assert_eq!(
                    self.count(&compare.structure),
                    expected,
                    "compare at {date}"
                );
                let assigned: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM employment_assignments WHERE employee_id=$1 \
                     AND superseded_at IS NULL AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)",
                ).bind(self.employee).bind(date).fetch_one(owner).await.unwrap();
                assert_eq!(assigned, expected, "assignment at {date}");
            }
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reported_last_working_day_counts_until_the_next_day(owner: PgPool) {
    let w = world(&owner).await;
    w.confirm(w.today).await;
    assert_eq!(
        w.state(&owner).await,
        ("ACTIVE".into(), "SCHEDULED".into(), w.today.to_string())
    );
    assert_eq!(w.live().await, 1);
    w.boundary(&owner, w.today).await;
    assert_eq!(w.hr.apply_due(w.today).await.unwrap(), 0);
    assert_eq!(w.live().await, 1);
    assert_eq!(
        w.hr.apply_due(w.today.next_day().unwrap()).await.unwrap(),
        1
    );
    assert_eq!(
        w.state(&owner).await,
        ("EXITED".into(), "APPLIED".into(), w.today.to_string())
    );
    assert_eq!(w.live().await, 0);
    assert_eq!(
        w.hr.apply_due(w.today.next_day().unwrap()).await.unwrap(),
        0
    );
    w.boundary(&owner, w.today).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn backdated_report_keeps_the_stored_last_working_day_counted(owner: PgPool) {
    let w = world(&owner).await;
    let last_day = w.today - Duration::days(5);
    w.confirm(last_day).await;
    assert_eq!(
        w.state(&owner).await,
        ("EXITED".into(), "APPLIED".into(), last_day.to_string())
    );
    assert_eq!(w.live().await, 0);
    w.boundary(&owner, last_day).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_exit_is_not_applied_on_its_last_working_day(owner: PgPool) {
    let w = world(&owner).await;
    let last_day = w.today.next_day().unwrap();
    w.confirm(last_day).await;
    assert_eq!(w.hr.apply_due(last_day).await.unwrap(), 0);
    assert_eq!(
        w.state(&owner).await,
        ("ACTIVE".into(), "SCHEDULED".into(), last_day.to_string())
    );
    assert_eq!(
        w.hr.apply_due(last_day.next_day().unwrap()).await.unwrap(),
        1
    );
    assert_eq!(
        w.state(&owner).await,
        ("EXITED".into(), "APPLIED".into(), last_day.to_string())
    );
    w.boundary(&owner, last_day).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_offboard_waits_until_after_the_last_working_day(owner: PgPool) {
    let w = world(&owner).await;
    let last_day = w.today.next_day().unwrap();
    w.confirm(last_day).await;
    // OFFBOARD is the legacy spelling of the exit-case writer's TERMINATE.
    sqlx::query(
        "UPDATE employee_lifecycle_events SET event_type='OFFBOARD', \
         scheduled_request=jsonb_set(scheduled_request,'{event_type}','\"OFFBOARD\"') WHERE employee_id=$1",
    )
    .bind(w.employee)
    .execute(&owner)
    .await
    .unwrap();
    assert_eq!(w.hr.apply_due(last_day).await.unwrap(), 0);
    w.boundary(&owner, last_day).await;
    assert_eq!(
        w.hr.apply_due(last_day.next_day().unwrap()).await.unwrap(),
        1
    );
    assert_eq!(w.live().await, 0);
    w.boundary(&owner, last_day).await;
}
