// SPDX-License-Identifier: LicenseRef-Proprietary
//! The in-window scale fixture, retaining birthdays and a small due cohort.
use console_kernel_core::UserId;
use sqlx::PgPool;
use uuid::Uuid;

pub async fn seed(
    pool: &PgPool,
    org: Uuid,
    user: UserId,
    entity: Uuid,
    site: Uuid,
    count: i32,
    due: i32,
) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employees (org_id,company,name,employee_number,employment_status,source_filename,source_sheet,source_row,source_key,hire_date,hire_on,birth_date) SELECT $1,'Test','Birthday worker '||n,'AGE-'||n,'ACTIVE','age.xlsx','Sheet',n,'age-window-'||n,(current_date-30)::text,current_date-30,CASE WHEN n <= $3 THEN (current_date-interval '60 years')::date ELSE (current_date-interval '30 years')::date END FROM generate_series(1,$2) n ON CONFLICT DO NOTHING")
        .bind(org).bind(count).bind(due).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) SELECT $1,id,$2,$3,current_date-30,'MIGRATION',gen_random_uuid() FROM employees e WHERE org_id=$1 AND source_key LIKE 'age-window-%' AND NOT EXISTS (SELECT 1 FROM employment_assignments a WHERE a.org_id=e.org_id AND a.employee_id=e.id)")
        .bind(org).bind(entity).bind(site).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,to_status,effective_date,comment,created_by,state,created_at) SELECT $1,id,'ONBOARD','ACTIVE',(current_date-30)::text,'birthday hire',$2,'APPLIED',now()-interval '30 days' FROM employees e WHERE org_id=$1 AND source_key LIKE 'age-window-%' AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events l WHERE l.org_id=e.org_id AND l.employee_id=e.id)")
        .bind(org).bind(user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    sqlx::raw_sql(
        "ANALYZE employees; ANALYZE employment_assignments; ANALYZE employee_lifecycle_events",
    )
    .execute(pool)
    .await
    .unwrap();
}
