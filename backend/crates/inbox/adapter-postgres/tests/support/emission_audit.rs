// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn payslip_is_frictionless_and_never_receipt_confirmed(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let sae = OrgId::one();
    let user = seed_user(&owner_pool, *sae.as_uuid(), "Payee").await;
    let store = PgInboxStore::new(rt_pool.clone());

    let pay = console_platform_request_context::scope_org(sae, async {
        let mut command = payslip_to(user);
        command.actor = Some(user);
        store.emit_inbox_doc(command).await
    })
    .await
    .expect("emit payslip");
    let audit: (String, String, String) = sqlx::query_as(
        "SELECT source, actor_kind, principal_type FROM audit_events
         WHERE action='inbox_doc.emit' AND target_id=$1",
    )
    .bind(pay.id.to_string())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        audit,
        ("API".into(), "TENANT_USER".into(), "TENANT_USER".into())
    );
    assert!(
        !pay.locked,
        "a payslip is never locked (frictionless self-view)"
    );

    // Self-view discloses the body immediately, no confirmation gate.
    let view = console_platform_request_context::scope_org(sae, async {
        store
            .get(GetInboxDocQuery {
                recipient: user,
                id: pay.id,
            })
            .await
    })
    .await
    .expect("payslip self-view");
    assert!(
        view.payload.is_some(),
        "payslip body is always visible to its owner"
    );

    // A payslip cannot be receipt-confirmed.
    let rejected = console_platform_request_context::scope_org(sae, async {
        store.confirm_receipt(confirm(user, pay.id)).await
    })
    .await;
    assert_eq!(
        rejected
            .expect_err("payslip confirm must be rejected")
            .kind(),
        ErrorKind::Validation,
        "a payslip is a self-view, not a receipt-gated legal notice"
    );
}
