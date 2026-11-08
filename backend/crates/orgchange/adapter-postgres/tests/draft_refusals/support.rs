// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) fn legacy_places() -> [Vec<OrgProposalOp>; 4] {
    [
        vec![OrgProposalOp::CreateSite {
            customer_id: Uuid::new_v4(),
            name: "새 현장".into(),
        }],
        vec![OrgProposalOp::UpdateSite {
            site_id: Uuid::new_v4(),
            name: "현장 변경".into(),
        }],
        vec![OrgProposalOp::DeactivateRegion {
            region_id: Uuid::new_v4(),
        }],
        vec![OrgProposalOp::DeactivateBranch {
            branch_id: Uuid::new_v4(),
        }],
    ]
}

pub(super) async fn snapshot(pool: &PgPool) -> serde_json::Value {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT count(*) FROM org_change_requests),(SELECT count(*) FROM org_change_approval_steps),(SELECT count(*) FROM org_change_events),(SELECT count(*) FROM audit_events))")
        .fetch_one(pool).await.unwrap()
}
