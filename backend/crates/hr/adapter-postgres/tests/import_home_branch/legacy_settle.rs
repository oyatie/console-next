// SPDX-License-Identifier: LicenseRef-Proprietary
//! N-1 settle has no placement-routing context but still owns rollback provenance.
use console_hr_adapter_postgres::{
    corrections::SecondPersonContext, import::rollback::RollbackRequest,
};
use sqlx::PgPool;
use uuid::Uuid;

use super::shared::{setup_headquarters, stage_roster};
use crate::harness::importer;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_n_minus_one_settle_without_context_keeps_its_routing_inverse(pool: PgPool) {
    let i = importer(pool).await;
    setup_headquarters(&i, i.f.branch).await;
    // Emulate the released binary at the placement boundary, without changing its writers.
    sqlx::raw_sql("CREATE FUNCTION public.place_legacy_import_context() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM set_config('app.employee_import_run','',true); RETURN NEW; END $$;
        CREATE TRIGGER place_legacy_import_context BEFORE INSERT ON employment_assignments
        FOR EACH ROW EXECUTE FUNCTION public.place_legacy_import_context()")
        .execute(&i.owner).await.unwrap();
    let (run, digest) = stage_roster(
        &i,
        "명부",
        &[&[
            "N1-1",
            "이전버전",
            "2024-03-04",
            "정규직",
            "본사",
            "",
            "사원",
        ]],
    )
    .await;
    i.apply(run, &digest).await.unwrap();
    let effects = i
        .count(
            "SELECT count(*) FROM import_run_effects WHERE org_id=$1 AND effect='home_branch_set'",
        )
        .await;
    assert_eq!(
        effects, 1,
        "the trigger must leave the N-1 import's inverse intact"
    );
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
    i.f.hr
        .rollback_import(
            i.f.principal.clone(),
            run,
            RollbackRequest {
                preview_digest: preview.preview_digest,
                acknowledged: true,
                reason_code: None,
                note: None,
                step_up: None,
            },
            None,
            SecondPersonContext {
                other_eligible_holders: 0,
                sole_holder_refuse: false,
                routed: false,
            },
        )
        .await
        .unwrap();
    let branches: Vec<Option<Uuid>> =
        sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE org_id=$1")
            .bind(i.org())
            .fetch_all(&i.owner)
            .await
            .unwrap();
    assert_eq!(branches, vec![None]);
}
