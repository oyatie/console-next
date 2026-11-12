// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_kernel_core::TenantPhase;
use console_platform_authz::access::AccessSubject;

#[tokio::test]
async fn access_snapshot_is_read_only_identity_bound_and_request_local() {
    let org = OrgId::new();
    let actor = Uuid::new_v4();
    for method in ["GET", "HEAD", "POST", "PATCH", "DELETE"] {
        with_request_line(
            RequestLine {
                method: method.into(),
                path: "/".into(),
            },
            async {
                let snapshot = Arc::new(AccessSnapshot::new(AccessSubject {
                    org,
                    account: actor,
                    is_ops: false,
                    phase: TenantPhase::Setup,
                    grants: Vec::new(),
                }));
                assert!(ACCESS_SNAPSHOT.with(|slot| slot.set(snapshot)).is_ok());
                assert_eq!(
                    current_access_snapshot(org, actor).is_some(),
                    matches!(method, "GET" | "HEAD")
                );
                assert!(current_access_snapshot(OrgId::new(), actor).is_none());
                assert!(current_access_snapshot(org, Uuid::new_v4()).is_none());
            },
        )
        .await;
    }
    with_request_line(
        RequestLine {
            method: "GET".into(),
            path: "/".into(),
        },
        async {
            assert!(current_access_snapshot(org, actor).is_none());
        },
    )
    .await;
    assert!(current_access_snapshot(org, actor).is_none());
}
