// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use std::collections::HashSet;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tied_timestamps_paginate_all_vouchers_and_account_entries(pool: PgPool) {
    seed_org(&pool, ORG_A, "A").await;
    let branch = seed_branch(&pool, ORG_A).await;
    let actor = seed_user(&pool, ORG_A).await;
    // rls-arming: ok owner seeds 501 tied headers and two same-account entries per voucher.
    sqlx::query(
        "INSERT INTO finance_gl_vouchers(org_id,branch_id,created_by,voucher_no,status,memo)
        SELECT $1,$2,$3,'audit-'||n,'DRAFT','' FROM generate_series(1,501) n",
    )
    .bind(ORG_A)
    .bind(branch.as_uuid())
    .bind(actor.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO finance_gl_voucher_lines(org_id,voucher_id,line_no,account_code,side,amount_won)
        SELECT org_id,id,n,'1000',CASE WHEN n=1 THEN 'DEBIT' ELSE 'CREDIT' END,100
        FROM finance_gl_vouchers CROSS JOIN generate_series(1,2) n WHERE org_id=$1")
        .bind(ORG_A).execute(&pool).await.unwrap();
    let store = PgVoucherStore::new(runtime_role_pool(&pool).await);
    console_platform_request_context::scope_org(OrgId::from_uuid(ORG_A), async {
        let (first, cursor) = store.list_page(Some(branch), None, None).await.unwrap();
        assert_eq!(first.len(), 500);
        assert!(
            first.iter().all(|v| v.lines.len() == 2
                && v.credit_total_won == 100
                && v.debit_total_won == 100)
        );
        let (last, end) = store
            .list_page(Some(branch), None, Some(cursor.unwrap()))
            .await
            .unwrap();
        assert_eq!((last.len(), end), (1, None));
        assert_eq!(
            first
                .iter()
                .chain(&last)
                .map(|v| v.id)
                .collect::<HashSet<_>>()
                .len(),
            501
        );
        let (entries, cursor) = store.account_page("1000", None).await.unwrap();
        assert_eq!(entries.len(), 1000);
        let (last, end) = store
            .account_page("1000", Some(cursor.unwrap()))
            .await
            .unwrap();
        assert_eq!((last.len(), end), (2, None));
        assert_eq!(
            entries
                .iter()
                .chain(&last)
                .map(|e| e.line_id)
                .collect::<HashSet<_>>()
                .len(),
            1002
        );
    })
    .await;
}
