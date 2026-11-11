// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;

use console_inbox_adapter_postgres::PgInboxStore;
use console_leave_adapter_postgres::PgLeaveStore;
use sqlx::PgPool;
use std::sync::Arc;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_reads_contact_facts_only_for_matching_names(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let other = f
        .create(f.body("other-name", "REGULAR"))
        .await
        .unwrap()
        .employee_id();
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE OR REPLACE FUNCTION console_employee_facts(p_org UUID,p_employee UUID) RETURNS JSONB \
         LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ BEGIN \
         IF p_employee='{other}'::uuid THEN RAISE EXCEPTION 'unmatched contact facts must not be read'; END IF; \
         RETURN public.console_person_facts(p_org,public.console_employee_person(p_org,p_employee)); END $$;"
    ))).execute(&pool).await.unwrap();
    let mut body = f.body("new-name", "REGULAR");
    body.name = "다른 직원".into();
    body.home_branch_id = None;
    let store = PgLeaveStore::new(f.rt.clone(), Arc::new(PgInboxStore::new(f.rt.clone())));
    let (_, employee) =
        f.hr.create_employee(f.principal.clone(), store, body)
            .await
            .unwrap();
    assert_ne!(employee.employee_id(), other);
}
