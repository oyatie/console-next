// SPDX-License-Identifier: LicenseRef-Proprietary
//! An unrelated transfer committed during preflight is not part of its proposal.
use super::fixture::{day, tenant};
use console_kernel_core::{OrgId, UserId};
use console_ontology_canonical_adapter_postgres::employment::set_employee_org_unit;
use console_orgchange_adapter_postgres::{
    EmploymentTransferPort, PeopleMove, PeopleMoveCause, PeopleMoved, PgOrgChangeStore,
    TransferPortFuture,
};
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use std::sync::Arc;
use tokio::sync::Notify;
use uuid::Uuid;

struct PausedEmptyTransfer {
    started: Arc<Notify>,
    resume: Arc<Notify>,
}
impl EmploymentTransferPort for PausedEmptyTransfer {
    fn move_people<'tx>(
        &self,
        _tx: &'tx mut Transaction<'_, Postgres>,
        _org: OrgId,
        _actor: UserId,
        _cause: PeopleMoveCause,
        _what: PeopleMove,
    ) -> TransferPortFuture<'tx> {
        let (started, resume) = (self.started.clone(), self.resume.clone());
        Box::pin(async move {
            started.notify_one();
            resume.notified().await;
            Ok(PeopleMoved::default())
        })
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_unrelated_transfer_is_excluded_from_proposal_impact(pool: PgPool) {
    let t = tenant(pool).await;
    let empty = t.dept("Empty", t.sites[0]).await;
    let other = t.dept("Other", t.sites[0]).await;
    let target = t.dept("Target", t.sites[0]).await;
    let person = t
        .person("Other person", other, t.workplaces[0], "ACTIVE")
        .await;
    let request = t
        .draft(
            "REORG",
            empty,
            json!([{"op":"REASSIGN_ORG_UNIT","fromOrgUnit":empty,
        "toOrgUnit":target,"scope":{"company":"Co"}}]),
            &day(2),
        )
        .await;
    let (started, resume) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let runtime = console_platform_test_support::runtime_role_pool(&t.owner).await;
    let store =
        PgOrgChangeStore::new(runtime).with_employment_transfer(Arc::new(PausedEmptyTransfer {
            started: started.clone(),
            resume: resume.clone(),
        }));
    let (org, actor) = (OrgId::from_uuid(t.org), UserId::from_uuid(t.actor));
    let pending = tokio::spawn(console_platform_request_context::scope_org(
        org,
        async move {
            store
                .preflight(actor, Uuid::parse_str(&request).unwrap())
                .await
        },
    ));
    tokio::time::timeout(std::time::Duration::from_secs(30), started.notified())
        .await
        .unwrap();
    let mut concurrent = t.owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(t.org.to_string())
        .execute(concurrent.as_mut())
        .await
        .unwrap();
    set_employee_org_unit(&mut concurrent, t.org, person, Some(target), Some("Target"))
        .await
        .unwrap();
    concurrent.commit().await.unwrap();
    resume.notify_one();
    let result = pending.await.unwrap().unwrap();
    assert_eq!(
        result.preflight.unwrap().headcount,
        0,
        "the empty source moves nobody"
    );
    assert_eq!(
        t.unit_of(person).await,
        Some(target),
        "the unrelated transfer committed"
    );
}
