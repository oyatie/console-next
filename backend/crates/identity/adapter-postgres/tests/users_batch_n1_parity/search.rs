// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use console_identity_adapter_postgres::PgOrgStore;
use console_identity_application::{DirectoryListQuery, UserListQuery};
use console_kernel_core::{BranchScope, OrgId};
use console_platform_request_context::CURRENT_ORG;

pub(crate) async fn assert_search_edge_cases(
    store: &PgOrgStore,
    org_a: OrgId,
    scope: &BranchScope,
) {
    for empty_login in ["@example.com", "@"] {
        let u_res = CURRENT_ORG
            .scope(
                org_a,
                store.list_users(
                    scope,
                    UserListQuery {
                        include_inactive: false,
                        limit: Some(50),
                        offset: Some(0),
                        search: Some(empty_login.to_owned()),
                    },
                ),
            )
            .await
            .unwrap();
        assert_eq!(u_res.total, 0, "list_users({empty_login})");

        let d_res = CURRENT_ORG
            .scope(
                org_a,
                store.list_directory_people(
                    scope,
                    DirectoryListQuery {
                        search: Some(empty_login.to_owned()),
                        team: None,
                        branch_id: None,
                        roles: Vec::new(),
                        include_inactive: false,
                        limit: Some(50),
                        offset: Some(0),
                    },
                ),
            )
            .await
            .unwrap();
        assert_eq!(d_res.total, 0, "list_directory_people({empty_login})");
    }

    for (term, expected_name) in [
        ("%", "Literal 50%_Match"),
        ("50%_", "Literal 50%_Match"),
        ("\\", "Back\\Slash"),
    ] {
        let d_res = CURRENT_ORG
            .scope(
                org_a,
                store.list_directory_people(
                    scope,
                    DirectoryListQuery {
                        search: Some(term.to_owned()),
                        team: None,
                        branch_id: None,
                        roles: Vec::new(),
                        include_inactive: false,
                        limit: Some(50),
                        offset: Some(0),
                    },
                ),
            )
            .await
            .unwrap();
        assert_eq!(d_res.total, 1, "list_directory_people({term})");
        assert_eq!(d_res.items[0].display_name, expected_name);
    }

    let d_under = CURRENT_ORG
        .scope(
            org_a,
            store.list_directory_people(
                scope,
                DirectoryListQuery {
                    search: Some("_".to_owned()),
                    team: None,
                    branch_id: None,
                    roles: Vec::new(),
                    include_inactive: false,
                    limit: Some(50),
                    offset: Some(0),
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(d_under.total, 2, "only Literal 50%_Match and alpha_login");
}
