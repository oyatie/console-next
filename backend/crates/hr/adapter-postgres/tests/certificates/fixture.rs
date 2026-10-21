// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Certificate product contract, through the runtime role and the service used by HTTP.
use console_hr_adapter_postgres::{
    HrService,
    certificates::{CertificateActionRequest, CertificateSettingsRequest, IssueCertificateRequest},
};
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

pub(super) struct World {
    pub(super) owner: PgPool,
    pub(super) hr: HrService,
    pub(super) actor: Principal,
    pub(super) employee: Uuid,
    pub(super) entity: Uuid,
}
impl World {
    pub(super) async fn new(owner: PgPool) -> Self {
        let (org, user) = (OrgId::new(), UserId::new());
        sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Certificate test')")
            .bind(org.as_uuid())
            .bind(org.to_string())
            .execute(&owner)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users(id,org_id,display_name,roles) VALUES($1,$2,'Issuer',ARRAY['SUPER_ADMIN'])").bind(user.as_uuid()).bind(org.as_uuid()).execute(&owner).await.unwrap();
        let employee = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,hire_date,position,source_filename,source_sheet,source_row,source_key) VALUES($1,'Test employer','정하늘','2020-01-02','사원','test','test',1,$2) RETURNING id").bind(org.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(&owner).await.unwrap();
        let entity = Self::entity(&owner, *org.as_uuid(), "Test employer").await;
        sqlx::query("INSERT INTO employment_assignments(org_id,employee_id,legal_entity_id,valid_from,cause,command_id) VALUES($1,$2,$3,'2020-01-02','MIGRATION',gen_random_uuid())").bind(org.as_uuid()).bind(employee).bind(entity).execute(&owner).await.unwrap();
        let rt = console_platform_test_support::runtime_role_pool(&owner).await;
        Self {
            owner,
            hr: HrService::new(rt),
            actor: Principal::new(
                user,
                org,
                BTreeSet::from([Role::SuperAdmin]),
                BranchScope::All,
            ),
            employee,
            entity,
        }
    }
    pub(super) async fn entity(pool: &PgPool, org: Uuid, name: &str) -> Uuid {
        let id = Uuid::new_v4();
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL session_replication_role = replica")
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES($1,$2,true,'MIGRATION')").bind(org).bind(id).execute(tx.as_mut()).await.unwrap();
        sqlx::query("INSERT INTO legal_entity_revisions(org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot) VALUES($1,$2,1,gen_random_uuid(),'2020-01-01',$3,'MIGRATION','TEST',sha256('x'::bytea),'{}')").bind(org).bind(id).bind(name).execute(tx.as_mut()).await.unwrap();
        tx.commit().await.unwrap();
        id
    }
    pub(super) async fn assign(&self, entity: Uuid) {
        let mut tx = self.owner.begin().await.unwrap();
        sqlx::query("UPDATE employment_assignments SET superseded_at=now() WHERE employee_id=$1 AND superseded_at IS NULL").bind(self.employee).execute(tx.as_mut()).await.unwrap();
        sqlx::query("INSERT INTO employment_assignments(org_id,employee_id,legal_entity_id,valid_from,cause,command_id) VALUES($1,$2,$3,'2020-01-02','MIGRATION',gen_random_uuid())").bind(self.actor.org_id.as_uuid()).bind(self.employee).bind(entity).execute(tx.as_mut()).await.unwrap();
        tx.commit().await.unwrap();
    }
    pub(super) fn issue_body(&self) -> IssueCertificateRequest {
        serde_json::from_value(json!({"employee_id":self.employee,"kind":"EMPLOYMENT","items":["period"],"purpose":"제출용"})).unwrap()
    }
    pub(super) fn settings(&self) -> CertificateSettingsRequest {
        serde_json::from_value(json!({"legal_entity_id":self.entity,"prefix":"HR","width":6,"seal_text":"Test employer 대표이사","expected_version":0})).unwrap()
    }
    pub(super) async fn configure(&self) {
        self.hr
            .set_certificate_settings(self.actor.clone(), self.settings())
            .await
            .unwrap();
    }
    pub(super) async fn count(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM hr_certificates WHERE org_id=$1")
            .bind(self.actor.org_id.as_uuid())
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }
    pub(super) async fn issue(&self, key: &str) -> Value {
        self.hr
            .issue_certificate(self.actor.clone(), Some(key.into()), self.issue_body())
            .await
            .unwrap()
    }
    pub(super) fn reason() -> CertificateActionRequest {
        serde_json::from_value(json!({"reason":"발급 내용 정정"})).unwrap()
    }
}
