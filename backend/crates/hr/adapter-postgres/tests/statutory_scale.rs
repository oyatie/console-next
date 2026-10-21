#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
#[path = "statutory/world.rs"]
mod world;
use sqlx::PgPool;
use support::principal;
use world::{list, register, register_rules, world};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn statutory_two_thousand_workers_have_exact_counts_and_untruncated_exports(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employees (org_id,company,name,employee_number,employment_status,source_filename,source_sheet,source_row,source_key,raw_row,source_metadata,hire_date,hire_on) SELECT $1,'Test','Worker '||n,'S-'||n,'ACTIVE','test.xlsx','Sheet',n,'scale-'||n,'{}','{}','2026-09-01','2026-09-01' FROM generate_series(1,2000) n")
        .bind(w.tenant.org).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) SELECT $1,id,$2,$3,'2026-09-01','MIGRATION',gen_random_uuid() FROM employees WHERE org_id=$1 AND source_filename='test.xlsx' AND source_key LIKE 'scale-%'")
        .bind(w.tenant.org).bind(w.entity).bind(w.site).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,to_status,effective_date,comment,created_by,state) SELECT $1,id,'ONBOARD','ACTIVE','2026-09-01','hire',$2,'APPLIED' FROM employees WHERE org_id=$1 AND source_key LIKE 'scale-%'")
        .bind(w.tenant.org).bind(w.user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let page = w
        .tenant
        .hr
        .insurance_filings(p.clone(), list(), register_rules(&pool).await)
        .await
        .unwrap();
    assert_eq!(
        (page.total, page.pending, page.items.len()),
        (8004, 8004, 50)
    );
    let page = w
        .tenant
        .hr
        .worker_register(p.clone(), register(w.site, "2026-09-02"))
        .await
        .unwrap();
    assert_eq!((page.total, page.items.len()), (2001, 1));
    let file = w
        .tenant
        .hr
        .export_worker_register(
            p,
            register(w.site, "2026-09-02"),
            console_hr_adapter_postgres::statutory::RegisterExport {
                format: "pdf".into(),
                export_purpose: Some("AUDIT_RESPONSE".into()),
            },
        )
        .await
        .unwrap();
    let print: serde_json::Value = serde_json::from_slice(&file.bytes).unwrap();
    assert_eq!(print["items"].as_array().unwrap().len(), 2001);
    assert!(
        print["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["cells"][0] == "S-2000")
    );
}
