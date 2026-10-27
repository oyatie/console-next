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
    // The inbox traverses the same membership without materializing it on every page.
    let as_of = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut after = None;
    let mut seen = std::collections::BTreeSet::new();
    loop {
        let (page, _) = w
            .tenant
            .hr
            .insurance_inbox_page(
                p.clone(),
                console_hr_adapter_postgres::statutory::FilingQuery {
                    inbox_as_of: Some(as_of),
                    limit: Some(200),
                    state: Some("PENDING".into()),
                    ..list()
                },
                register_rules(&pool).await,
                after,
            )
            .await
            .unwrap();
        for task in &page.items {
            assert!(seen.insert(task.inbox_id()), "duplicate filing task");
        }
        if page.next.is_none() {
            break;
        }
        let last = page
            .items
            .last()
            .expect("a continuation must make progress");
        after = Some(world::inbox_position(last));
    }
    assert_eq!(seen.len(), 8004);
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn resolved_statutory_history_does_not_hide_the_pending_tail(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let completed = world::complete(0);
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employees (org_id,company,name,employee_number,employment_status,source_filename,source_sheet,source_row,source_key,hire_date,hire_on) SELECT $1,'Test','Completed worker '||n,'H-'||n,'ACTIVE','history.xlsx','Sheet',n,'resolved-'||n,'2026-09-01','2026-09-01' FROM generate_series(1,5001) n")
        .bind(w.tenant.org).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) SELECT $1,id,$2,$3,'2026-09-01','MIGRATION',gen_random_uuid() FROM employees WHERE org_id=$1 AND source_filename='history.xlsx'")
        .bind(w.tenant.org).bind(w.entity).bind(w.site).execute(tx.as_mut()).await.unwrap();
    // The existing world remains pending after 20,004 completed candidates.
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,to_status,effective_date,comment,created_by,state,created_at) SELECT $1,id,'ONBOARD','ACTIVE','2026-09-01','completed hire',$2,'APPLIED',(SELECT created_at - interval '1 day' FROM employee_lifecycle_events WHERE org_id=$1 AND id=$3) FROM employees WHERE org_id=$1 AND source_filename='history.xlsx'")
        .bind(w.tenant.org).bind(w.user.as_uuid()).bind(w.event).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO insurance_filing_records (org_id,event_id,filing_kind,insurer,version,action,completed_on,receipt_number,actor,idempotency_key,request_hash,applicability_facts) SELECT l.org_id,l.id,'ACQUIRE',i.insurer,1,'COMPLETE',$3::date,'history-'||l.id||'-'||i.insurer,$2,'history-'||l.id||'-'||i.insurer,repeat('a',64),$4 FROM employee_lifecycle_events l JOIN employees e ON e.org_id=l.org_id AND e.id=l.employee_id CROSS JOIN unnest(ARRAY['NPS','NHIS','EI','IACI']) i(insurer) WHERE l.org_id=$1 AND e.source_filename='history.xlsx'")
        .bind(w.tenant.org).bind(w.user.as_uuid()).bind(completed.completed_on)
        .bind(serde_json::to_value(completed.applicability_facts).unwrap())
        .execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let as_of = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let (page, exact) = w
        .tenant
        .hr
        .insurance_inbox_page(
            p,
            console_hr_adapter_postgres::statutory::FilingQuery {
                inbox_as_of: Some(as_of),
                state: Some("PENDING".into()),
                limit: Some(200),
                ..list()
            },
            register_rules(&pool).await,
            None,
        )
        .await
        .expect("completed history must not make the shared inbox unavailable");
    assert!(exact, "the complete finite candidate set was scanned");
    assert_eq!((page.total, page.pending, page.items.len()), (4, 4, 4));
    assert!(page.next.is_none());
    assert!(page.items.iter().all(|task| task.event_id == w.event));
}
