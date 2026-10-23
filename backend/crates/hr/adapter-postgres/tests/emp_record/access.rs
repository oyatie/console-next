//! Shared persons, access and the tenant force-remove sweep.

use std::collections::BTreeSet;

use console_hr_adapter_postgres::record::CreateRecordRequest;
use console_hr_domain::record::Section;
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use sqlx::PgPool;
use uuid::Uuid;

use crate::fixture::{education, fixture};

fn create(fields: serde_json::Value) -> CreateRecordRequest {
    CreateRecordRequest { fields }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_employments_of_one_person_share_entries_and_access_is_closed(pool: PgPool) {
    let f = fixture(pool).await;
    let p = || f.principal.clone();
    let first = f.employee("E-4").await;
    let second = f.employee("E-5").await;
    let (row, _) =
        f.hr.create_record(
            p(),
            first,
            Section::Education,
            Uuid::new_v4(),
            create(education("한국고")),
        )
        .await
        .unwrap();
    sqlx::query("DELETE FROM employee_person_bindings WHERE org_id=$1 AND employee_id=$2")
        .bind(f.org)
        .bind(second)
        .execute(&f.owner)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employee_person_bindings (org_id, employee_id, person_id, actor_id, payload_digest) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(f.org).bind(second).bind(first).bind(f.user).bind(vec![1_u8; 32])
    .execute(&f.owner).await.unwrap();
    let seen =
        f.hr.employee_records(p(), second, None, false, None)
            .await
            .unwrap();
    assert_eq!(
        seen.items.iter().map(|i| i.id).collect::<Vec<_>>(),
        [row.id]
    );

    // Branch-scoped and foreign-tenant principals get nothing.
    let narrow = Principal::new(
        f.principal.user_id,
        f.principal.org_id,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::Branches(BTreeSet::new()),
    );
    assert_eq!(
        f.hr.employee_records(narrow, first, None, false, None)
            .await
            .unwrap_err()
            .status,
        403
    );
    let other = fixture(f.owner.clone()).await;
    let foreign = Principal::new(
        UserId::from_uuid(other.user),
        OrgId::from_uuid(other.org),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    assert_eq!(
        f.hr.employee_records(foreign, first, None, false, None)
            .await
            .unwrap_err()
            .status,
        404
    );
}

/// The record tables are RESTRICT children of `organizations`, so tenant
/// force-remove's catalog sweep clears them before `users` and `persons` go.
/// (The whole removal of a tenant with Person bindings is refused on trunk by
/// `employee_person_bindings` → `employees` RESTRICT, a pre-existing gap the
/// TENANT-REMOVE lane's sweep owns; this proves only this lane's tables.)
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_force_remove_sweeps_the_record_tables(pool: PgPool) {
    let f = fixture(pool).await;
    let emp = f.employee("E-6").await;
    let fields = create(education("한국고"));
    f.hr.create_record(
        f.principal.clone(),
        emp,
        Section::Education,
        Uuid::new_v4(),
        fields,
    )
    .await
    .unwrap();
    // rls-arming: ok owner-pool platform maintenance
    sqlx::query("SELECT platform_force_remove_direct_org_children($1)")
        .bind(f.org)
        .execute(&f.owner)
        .await
        .unwrap();
    for table in [
        "person_record_entries",
        "person_record_revisions",
        "person_record_import_batches",
    ] {
        let sql = format!("SELECT count(*) FROM {table} WHERE org_id = $1");
        // rls-arming: ok owner-pool assertion
        let left: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
            .bind(f.org)
            .fetch_one(&f.owner)
            .await
            .unwrap();
        assert_eq!(left, 0, "{table}");
    }
}
