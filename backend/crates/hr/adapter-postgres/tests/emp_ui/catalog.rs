//! 직급 · 직위 · 직책 · 직무 · 직군 writes through Cedar `job_title_manage`.

use console_hr_adapter_postgres::job_title::{
    CreateJobTitleRequest, JobTitleListQuery, UpdateJobTitleRequest,
};
use console_kernel_core::BranchScope;
use console_platform_authz::{Feature, Principal, Role};
use serde_json::json;
use sqlx::PgPool;

use crate::{Fixture, fixture, one_branch, status};

fn add(kind: &str, label: &str, rank: Option<i32>) -> CreateJobTitleRequest {
    // Built directly: the wire validator refuses an unknown kind before the domain, and these
    // cases exercise the domain's own refusal (`job_title_kind_invalid`).
    CreateJobTitleRequest {
        kind: kind.to_owned(),
        label: label.to_owned(),
        grade_rank: rank,
    }
}

async fn try_add(
    f: &Fixture,
    who: &Principal,
    kind: &str,
    label: &str,
) -> Result<bool, (u16, &'static str)> {
    f.hr.create_job_title(who.clone(), add(kind, label, None))
        .await
        .map(|(_, created)| created)
        .map_err(|e| status(&e))
}

/// Regression (BE-EMP-UI, EMP-UI 12): on 3c988fc2 `authorize_manage` denied
/// everyone, so no tenant could fill its lists (POST /job-titles was 403 for
/// the ops account too).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_the_ops_account_fills_the_lists_inline(pool: PgPool) {
    let f = fixture(pool, false).await;
    // No seeds (#19): a new tenant has no entry in any list.
    assert_eq!(f.count("job_titles").await, 0);
    for (kind, label) in [
        ("GRADE", "G3"),
        ("TITLE", "과장"),
        ("POSITION", "팀장"),
        ("JOB", "품질"),
        ("JOB_FAMILY", "생산직"),
    ] {
        assert_eq!(try_add(&f, &f.ops, kind, label).await, Ok(true), "{kind}");
    }
    assert_eq!(f.audits("job_title.create").await, 5);
    let list =
        f.hr.job_titles(f.ops.clone(), JobTitleListQuery::default())
            .await
            .unwrap();
    assert_eq!(list.items.len(), 5);
    assert!(list.can_manage);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_tenant_wide_grant_reaches_the_lists_and_a_scoped_one_does_not(pool: PgPool) {
    let f = fixture(pool, true).await;
    let catalog = f.granted(Feature::JobTitleManage, BranchScope::All).await;
    let structure = f.granted(Feature::OrgChangeApply, BranchScope::All).await;
    assert_eq!(try_add(&f, &catalog, "JOB", "설비").await, Ok(true));
    assert_eq!(try_add(&f, &structure, "JOB", "물류").await, Ok(true));
    let scoped = f.granted(Feature::JobTitleManage, one_branch()).await;
    let scoped_structure = f.granted(Feature::OrgChangeApply, one_branch()).await;
    let reader = f
        .granted(Feature::EmployeeDirectoryRead, BranchScope::All)
        .await;
    let hr_manager = f
        .granted(Feature::EmployeeDirectoryManage, BranchScope::All)
        .await;
    let admin = f.other(&[Role::Admin], BranchScope::All).await;
    let ops_in_one_branch = f.other(&[Role::SuperAdmin], one_branch()).await;
    let before = (
        f.count("job_titles").await,
        f.audits("job_title.create").await,
    );
    for who in [
        &scoped,
        &scoped_structure,
        &reader,
        &hr_manager,
        &admin,
        &ops_in_one_branch,
    ] {
        assert_eq!(
            try_add(&f, who, "JOB", "영업").await,
            Err((403, "forbidden"))
        );
    }
    // Refused: no row, no audit; the list says so instead of offering 「+ 추가」.
    assert_eq!(
        before,
        (
            f.count("job_titles").await,
            f.audits("job_title.create").await
        )
    );
    let seen =
        f.hr.job_titles(reader.clone(), JobTitleListQuery::default())
            .await
            .unwrap();
    assert!(!seen.can_manage);
    assert_eq!(seen.items.len(), 2);
    let id = seen.items[0].id;
    let rename: UpdateJobTitleRequest = serde_json::from_value(json!({"label": "x"})).unwrap();
    let refused = f.hr.update_job_title(admin, id, rename).await.unwrap_err();
    assert_eq!(status(&refused), (403, "forbidden"));
    assert_eq!(f.audits("job_title.update").await, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bad_entries_are_refused_with_their_codes_and_a_repeat_is_harmless(pool: PgPool) {
    let f = fixture(pool, true).await;
    let ops = || f.ops.clone();
    for (body, code) in [
        (add("RANK", "x", None), "job_title_kind_invalid"),
        (add("JOB", " ", None), "job_title_label_invalid"),
        (
            add("JOB", &"가".repeat(101), None),
            "job_title_label_invalid",
        ),
        (add("POSITION", "팀장", Some(3)), "job_title_rank_invalid"),
        (add("GRADE", "G9", Some(1001)), "job_title_rank_invalid"),
        (add("GRADE", "G9", Some(-1)), "job_title_rank_invalid"),
    ] {
        let error = f.hr.create_job_title(ops(), body).await.unwrap_err();
        assert_eq!(status(&error), (422, code));
    }
    assert_eq!(f.count("job_titles").await, 0);
    assert_eq!(f.audits("job_title.create").await, 0);
    // The same label in the same list (any case) answers the row, unaudited.
    let (first, created) =
        f.hr.create_job_title(ops(), add("TITLE", "Lead", Some(5)))
            .await
            .unwrap();
    assert!(created);
    let (again, created) =
        f.hr.create_job_title(ops(), add("TITLE", "lead", None))
            .await
            .unwrap();
    assert!(!created);
    assert_eq!(first.id, again.id);
    assert_eq!(f.audits("job_title.create").await, 1);
    // A rename onto another entry's label is 409; nothing changes.
    let (other, _) =
        f.hr.create_job_title(ops(), add("TITLE", "Head", Some(6)))
            .await
            .unwrap();
    let onto: UpdateJobTitleRequest = serde_json::from_value(json!({"label": "Lead"})).unwrap();
    let taken =
        f.hr.update_job_title(ops(), other.id, onto)
            .await
            .unwrap_err();
    assert_eq!(status(&taken), (409, "job_title_label_taken"));
    assert_eq!(f.audits("job_title.update").await, 0);
    let hide: UpdateJobTitleRequest = serde_json::from_value(json!({"active": false})).unwrap();
    assert!(
        !f.hr
            .update_job_title(ops(), other.id, hide)
            .await
            .unwrap()
            .active
    );
    assert_eq!(f.audits("job_title.update").await, 1);
}
