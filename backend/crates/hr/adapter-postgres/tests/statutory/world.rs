#![allow(dead_code)]
use crate::support::{Tenant, employee, tenant, user};
use console_hr_adapter_postgres::statutory::{FilingQuery, RecordFiling, RegisterQuery};
use console_kernel_core::UserId;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

pub struct World {
    pub tenant: Tenant,
    pub user: UserId,
    pub employee: Uuid,
    pub event: Uuid,
    pub entity: Uuid,
    pub site: Uuid,
}
pub async fn world(pool: &PgPool) -> World {
    let tenant = tenant(pool).await;
    let user = user(pool, tenant.org, None).await;
    let employee = employee(pool, tenant.org, "<Kim>&", "=1+1", "ACTIVE").await;
    let (event, entity, site) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET hire_on = '2026-09-01', hire_date = '2026-09-01', birth_date='1990-01-01', job = 'HR' WHERE id = $1")
        .bind(employee).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
        .bind(tenant.org).bind(entity).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO workplaces (org_id,id,legal_entity_id,needs_confirmation,created_change_mode) VALUES ($1,$2,$3,true,'MIGRATION')")
        .bind(tenant.org).bind(site).bind(entity).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO workplace_revisions (org_id,workplace_id,version,command_id,effective_from,name,status,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),'2020-01-01','Site','CONTINUING','MIGRATION','test',sha256('x'::bytea),'{}')")
        .bind(tenant.org).bind(site).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,'2026-09-01','MIGRATION',gen_random_uuid())")
        .bind(tenant.org).bind(employee).bind(entity).bind(site).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,id,employee_id,event_type,to_status,effective_date,comment,created_by,state) VALUES ($1,$2,$3,'ONBOARD','ACTIVE','2026-09-01','hire',$4,'APPLIED')")
        .bind(tenant.org).bind(event).bind(employee).bind(user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    // The fixed September events belong to an already-operating tenant.
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at='2020-01-01',go_live_by=$2,go_live_preview_digest=repeat('0',64) WHERE org_id=$1")
        .bind(tenant.org).bind(user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    World {
        tenant,
        user,
        employee,
        event,
        entity,
        site,
    }
}
pub fn complete(version: i64) -> RecordFiling {
    serde_json::from_value(json!({"expected_version":version,"action":"COMPLETE","completed_on":"2026-09-02","receipt_number":"batch-001","applicability_facts":{"monthly_hours":160,"weekly_hours":40,"continuous_months":1,"daily":false,"foreign":false,"director_without_worker_status":false}})).unwrap()
}
pub fn list() -> FilingQuery {
    FilingQuery::default()
}
pub fn register(site: Uuid, date: &str) -> RegisterQuery {
    RegisterQuery {
        workplace_id: site,
        as_of: date.into(),
        after: None,
        limit: Some(1),
    }
}

pub async fn register_rules(
    pool: &PgPool,
) -> console_compliance_domain::statutory::StatutoryRegister {
    console_compliance_adapter_postgres::PgComplianceStore::new(pool.clone())
        .statutory_register()
        .await
        .unwrap()
}
