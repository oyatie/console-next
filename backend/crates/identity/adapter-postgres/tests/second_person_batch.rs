// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod second_person_support;
use console_identity_adapter_postgres::second_person::second_person_facts_in_tx;
use console_kernel_core::UserId;
use second_person_support::{holder, query};
use sqlx::PgPool;

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn batch_preserves_case_order_exclusions_and_viewer_identity(owner: PgPool) {
    let requester = holder(&owner, None, &["SUPER_ADMIN"], true, 400, true).await;
    let first = holder(&owner, None, &["SUPER_ADMIN"], true, 400, true).await;
    let second = holder(&owner, None, &["SUPER_ADMIN"], true, 400, true).await;
    let queries = [
        query(requester, &[]),
        query(requester, &[first]),
        query(first, &[requester, second]),
    ];
    let runtime = console_platform_test_support::runtime_role_pool(&owner).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(second_person_support::org().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let all = second_person_facts_in_tx(&mut tx, &queries, None)
        .await
        .unwrap();
    assert_eq!(
        all.iter()
            .map(|f| f.other_eligible_holders)
            .collect::<Vec<_>>(),
        vec![2, 1, 0]
    );
    assert!(all[0].eligible.contains(&first));
    assert!(!all[1].eligible.contains(&first));
    let mine = second_person_facts_in_tx(&mut tx, &queries, Some(UserId::from_uuid(first)))
        .await
        .unwrap();
    assert_eq!(
        mine.iter()
            .map(|f| f.other_eligible_holders)
            .collect::<Vec<_>>(),
        vec![1, 0, 0]
    );
    assert!(
        second_person_facts_in_tx(&mut tx, &[], None)
            .await
            .unwrap()
            .is_empty()
    );
}
