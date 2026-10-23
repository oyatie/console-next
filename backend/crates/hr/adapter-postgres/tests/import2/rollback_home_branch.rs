// SPDX-License-Identifier: LicenseRef-Proprietary
//! Import placement establishes only missing home branches; its inverse owns only those writes.
use super::*;
use crate::harness::Importer;

async fn workplace(i: &Importer, branch: Option<Uuid>) -> Uuid {
    let (org, entity, place) = (i.org(), Uuid::new_v4(), Uuid::new_v4());
    let mut tx = i.owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let sql = format!(
        "INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ('{org}','{entity}',true,'MIGRATION');
         INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id,effective_from,name,display_name,change_mode,reason_code,payload_digest,settings_snapshot)
         VALUES ('{org}','{entity}',1,gen_random_uuid(),'2020-01-01','주식회사 한빛','한빛','MIGRATION','TEST',sha256('x'::bytea),'{{}}');
         INSERT INTO workplaces (org_id,id,legal_entity_id,needs_confirmation,created_change_mode) VALUES ('{org}','{place}','{entity}',true,'MIGRATION');
         INSERT INTO workplace_revisions (org_id,workplace_id,version,command_id,effective_from,name,status,change_mode,reason_code,payload_digest,settings_snapshot)
         VALUES ('{org}','{place}',1,gen_random_uuid(),'2020-01-01','본사','CONTINUING','MIGRATION','TEST',sha256('x'::bytea),'{{}}')"
    );
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE workplaces SET default_branch_id=$3 WHERE org_id=$1 AND id=$2")
        .bind(org)
        .bind(place)
        .bind(branch)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    place
}

async fn stage(i: &Importer, rows: usize, position: &str) -> (Uuid, String) {
    let mut lines = vec![vec![
        "사번".into(),
        "성명".into(),
        "입사일".into(),
        "고용형태".into(),
        "사업장".into(),
        "직위".into(),
    ]];
    for n in 0..rows {
        lines.push(vec![
            format!("HB-{n:02}"),
            format!("지점테스트{n}"),
            "2024-03-04".into(),
            "정규직".into(),
            "본사".into(),
            position.into(),
        ]);
    }
    let refs: Vec<Vec<&str>> = lines
        .iter()
        .map(|r| r.iter().map(String::as_str).collect())
        .collect();
    let refs: Vec<&[&str]> = refs.iter().map(Vec::as_slice).collect();
    let run = i
        .preview(
            "지점명부.xlsx",
            &[table("명부", 0, &refs)],
            &Default::default(),
        )
        .await
        .unwrap()
        .run_id;
    let dry = i.dry_run(run, decisions()).await;
    assert_eq!(dry.review.blocking, 0, "{:?}", dry.review.items);
    (run, dry.dry_run_digest)
}

async fn branches(i: &Importer) -> Vec<Option<Uuid>> {
    sqlx::query_scalar(
        "SELECT home_branch_id FROM employees WHERE org_id=$1 ORDER BY employee_number",
    )
    .bind(i.org())
    .fetch_all(&i.owner)
    .await
    .unwrap()
}

async fn undo(i: &Importer, run: Uuid) {
    let p =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    assert!(p.blockers.is_empty(), "{:?}", p.blockers);
    i.f.hr
        .rollback_import(
            i.f.principal.clone(),
            run,
            command(&p.preview_digest),
            None,
            SOLO,
        )
        .await
        .unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn three_current_people_get_the_workplace_branch_and_rollback_removes_it(pool: PgPool) {
    let i = importer(pool).await;
    workplace(&i, Some(i.f.branch)).await;
    let (run, digest) = stage(&i, 3, "사원").await;
    i.apply(run, &digest).await.unwrap();
    assert_eq!(branches(&i).await, vec![Some(i.f.branch); 3]);
    assert_eq!(
        i.count(
            "SELECT count(*) FROM import_run_effects WHERE org_id=$1 AND effect='home_branch_set'"
        )
        .await,
        3
    );
    i.apply(run, &digest).await.unwrap();
    assert_eq!(
        i.count(
            "SELECT count(*) FROM import_run_effects WHERE org_id=$1 AND effect='home_branch_set'"
        )
        .await,
        3
    );
    undo(&i, run).await;
    assert_eq!(branches(&i).await, vec![None; 3]);
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id=$1 AND employment_status='VOIDED'")
            .await,
        3
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn matched_unset_branch_is_previewed_and_restored_without_overwriting_an_existing_branch(
    pool: PgPool,
) {
    let i = importer(pool).await;
    let place = workplace(&i, None).await;
    let (first, digest) = stage(&i, 2, "사원").await;
    i.apply(first, &digest).await.unwrap();
    let employee = i.person("지점테스트0").await.0;
    let updated = sqlx::query_scalar("SELECT updated_at FROM employees WHERE org_id=$1 AND id=$2")
        .bind(i.org())
        .bind(employee)
        .fetch_one(&i.owner)
        .await
        .unwrap();
    console_platform_request_context::scope_org(
        i.f.principal.org_id,
        i.store.set_employee_home_branch(
            employee,
            i.f.branch,
            updated,
            i.f.principal.user_id,
            console_kernel_core::TraceContext::generate(),
        ),
    )
    .await
    .unwrap();
    let other: Uuid = sqlx::query_scalar("INSERT INTO branches (org_id,region_id,name) SELECT org_id,region_id,'새 지점' FROM branches WHERE id=$1 RETURNING id").bind(i.f.branch).fetch_one(&i.owner).await.unwrap();
    sqlx::query("UPDATE workplaces SET default_branch_id=$3 WHERE org_id=$1 AND id=$2")
        .bind(i.org())
        .bind(place)
        .bind(other)
        .execute(&i.owner)
        .await
        .unwrap();
    let (run, digest) = stage(&i, 2, "대리").await;
    i.apply(run, &digest).await.unwrap();
    assert_eq!(branches(&i).await, vec![Some(i.f.branch), Some(other)]);
    let p =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    let fields: Vec<_> = p
        .rows
        .iter()
        .flat_map(|r| &r.fields)
        .filter(|f| f.field == "home_branch_id")
        .collect();
    assert_eq!(fields.len(), 1);
    assert_eq!(fields[0].current.as_deref(), Some("새 지점"));
    assert!(fields[0].before.is_none());
    assert_eq!(
        i.count(
            "SELECT count(*) FROM import_run_effects WHERE org_id=$1 AND effect='home_branch_set'"
        )
        .await,
        1
    );
    undo(&i, run).await;
    assert_eq!(branches(&i).await, vec![Some(i.f.branch), None]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_workplace_without_a_default_branch_keeps_the_true_unset_flag(pool: PgPool) {
    let i = importer(pool).await;
    workplace(&i, None).await;
    let (run, digest) = stage(&i, 3, "사원").await;
    i.apply(run, &digest).await.unwrap();
    assert_eq!(branches(&i).await, vec![None; 3]);
    assert_eq!(
        i.count(
            "SELECT count(*) FROM import_run_effects WHERE org_id=$1 AND effect='home_branch_set'"
        )
        .await,
        0
    );
    undo(&i, run).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_later_matched_home_branch_assignment_blocks_rollback_without_clearing_it(pool: PgPool) {
    let i = importer(pool).await;
    let place = workplace(&i, None).await;
    let (first, digest) = stage(&i, 1, "사원").await;
    i.apply(first, &digest).await.unwrap();
    sqlx::query("UPDATE workplaces SET default_branch_id=$3 WHERE org_id=$1 AND id=$2")
        .bind(i.org())
        .bind(place)
        .bind(i.f.branch)
        .execute(&i.owner)
        .await
        .unwrap();
    let (run, digest) = stage(&i, 1, "대리").await;
    i.apply(run, &digest).await.unwrap();
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    let employee = i.person("지점테스트0").await.0;
    let other: Uuid = sqlx::query_scalar("INSERT INTO branches (org_id,region_id,name) SELECT org_id,region_id,'다른 지점' FROM branches WHERE id=$1 RETURNING id").bind(i.f.branch).fetch_one(&i.owner).await.unwrap();
    sqlx::query("UPDATE workplaces SET default_branch_id=$3 WHERE org_id=$1 AND id=$2")
        .bind(i.org())
        .bind(place)
        .bind(other)
        .execute(&i.owner)
        .await
        .unwrap();
    let updated = sqlx::query_scalar("SELECT updated_at FROM employees WHERE org_id=$1 AND id=$2")
        .bind(i.org())
        .bind(employee)
        .fetch_one(&i.owner)
        .await
        .unwrap();
    console_platform_request_context::scope_org(
        i.f.principal.org_id,
        i.store.set_employee_home_branch(
            employee,
            other,
            updated,
            i.f.principal.user_id,
            console_kernel_core::TraceContext::generate(),
        ),
    )
    .await
    .unwrap();
    let fresh =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    assert_eq!(
        fresh
            .rows
            .iter()
            .flat_map(|r| &r.fields)
            .find(|f| f.field == "home_branch_id")
            .unwrap()
            .current
            .as_deref(),
        Some("다른 지점")
    );
    assert_refused(
        &i,
        run,
        command(&preview.preview_digest),
        SOLO,
        409,
        "import_rollback_blocked",
    )
    .await;
    assert_eq!(branches(&i).await, vec![Some(other)]);
}
