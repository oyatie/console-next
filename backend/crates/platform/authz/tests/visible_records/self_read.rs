// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn live_employee_link_is_the_only_self_read_scope_even_for_ops(pool: PgPool) {
    let tenant = World::seed(&pool, &[vec![1]]).await;
    let foreign = World::seed(&pool, &[vec![1]]).await;
    let employee = Uuid::new_v4();
    let coworker = Uuid::new_v4();
    let outsider = Uuid::new_v4();
    for (id, org) in [
        (employee, tenant.org),
        (coworker, tenant.org),
        (outsider, foreign.org),
    ] {
        sqlx::query("INSERT INTO employees (id,org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES ($1,$2,'self-read','employee','self-read.xlsx','employees',1,$1::text)")
            .bind(id).bind(org.as_uuid()).execute(&pool).await.unwrap();
    }
    let rt = runtime_role_pool(&pool).await;
    for ops in [false, true] {
        let actor = tenant.holder(&pool, Some(NodeKind::Tenant), ops, 0).await;
        sqlx::query("UPDATE users SET employee_id=$2 WHERE id=$1")
            .bind(actor)
            .bind(employee)
            .execute(&pool)
            .await
            .unwrap();
        let mut tx = rt.begin().await.unwrap();
        arm(&mut tx, tenant.org).await;
        let facts = load_facts(&mut tx, tenant.org, actor).await.unwrap();
        assert_eq!(facts.linked_employee_id(), Some(employee));
        assert!(facts.authorize_employee_self_read(employee).unwrap());
        for denied in [coworker, outsider, Uuid::new_v4()] {
            assert!(!facts.authorize_employee_self_read(denied).unwrap());
        }
        tx.rollback().await.unwrap();
        sqlx::query("UPDATE users SET employee_id=NULL WHERE id=$1")
            .bind(actor)
            .execute(&pool)
            .await
            .unwrap();
        let mut tx = rt.begin().await.unwrap();
        arm(&mut tx, tenant.org).await;
        let facts = load_facts(&mut tx, tenant.org, actor).await.unwrap();
        assert_eq!(facts.linked_employee_id(), None);
        assert!(!facts.authorize_employee_self_read(employee).unwrap());
        tx.rollback().await.unwrap();
    }
}
