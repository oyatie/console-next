// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_platform_authz::Feature;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn receiving_employer_scope_cannot_read_or_complete_the_sending_employers_case(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (sending, wa) = f.entity(1).await;
    let (receiving, wb) = f.entity(1).await;
    f.place(sending, wa[0]).await;
    f.record(event(
        "GROUP_TRANSFER",
        &day(-2),
        json!({
            "to_workplace_id":wb[0],"group_transfer":{
                "continuity":"SETTLED","group_service_start_date":HIRE,
                "consent_date":day(-10),"consent_evidence_ref":"서명한 전적 동의서"
            }
        }),
    ))
    .await
    .unwrap();
    let cases =
        f.hr.employee_lifecycle_cases(f.principal.clone(), f.employee)
            .await
            .unwrap();
    let exit = cases.iter().find(|case| case.kind == "EXIT").unwrap();
    let principal = |read_scope| {
        Principal::new(
            f.principal.user_id,
            f.principal.org_id,
            BTreeSet::new(),
            BranchScope::All,
        )
        .with_scope_grants(vec![
            ScopeGrant {
                feature: Feature::EmployeeDirectoryRead,
                kind: read_scope,
                id: if read_scope == NodeKind::Tenant {
                    f.org
                } else {
                    receiving
                },
            },
            ScopeGrant {
                feature: Feature::EmployeeDirectoryManage,
                kind: NodeKind::LegalEntity,
                id: receiving,
            },
        ])
    };
    let error =
        f.hr.lifecycle_case(principal(NodeKind::LegalEntity), exit.id)
            .await
            .unwrap_err();
    assert_eq!(error.code, "out_of_scope");
    let visible =
        f.hr.employee_lifecycle_cases(principal(NodeKind::LegalEntity), f.employee)
            .await
            .unwrap();
    assert!(visible.iter().all(|case| case.kind == "HIRE"));
    let item = exit
        .items
        .iter()
        .find(|item| item.kind == "BACK" && item.status == "OPEN")
        .unwrap();
    let error =
        f.hr.complete_lifecycle_item(
            principal(NodeKind::Tenant),
            exit.id,
            item.id,
            serde_json::from_value(
                json!({"expected_version":item.version,"observed_ref":"untrusted"}),
            )
            .unwrap(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "lifecycle.refuse.owner_line");
}
