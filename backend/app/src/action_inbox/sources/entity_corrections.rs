// SPDX-License-Identifier: LicenseRef-Proprietary
//! Correction actions share the identity resolver used by decide and controller sign-off.
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
};
use console_entity_adapter_postgres::identifier_correction_inbox::open_conn;
use console_identity_adapter_postgres::second_person::{
    SecondPersonQuery, second_person_facts_in_tx,
};
use console_kernel_core::{BranchScope, KernelError, UserId};
use console_platform_authz::{Action, Feature, Principal, authorize_capability};
use sqlx::PgPool;

pub(crate) async fn page(
    pool: &PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    let empty = || ActionInboxSourcePage {
        items: vec![],
        total: 0,
        total_is_exact: true,
        has_more: false,
    };
    if principal.branch_scope != BranchScope::All
        || ![Feature::LegalEntityManage, Feature::OrgChangeApply]
            .into_iter()
            .any(|f| authorize_capability(principal, Action::new(f)).is_ok())
    {
        return Ok(empty());
    }
    let p = principal.clone();
    console_platform_db::with_org_conn::<_, _, console_governance_adapter_postgres::PgGovernanceError>(pool, p.org_id, move |tx| {
        Box::pin(async move {
            let cases = open_conn(tx.as_mut(), query.as_of).await?;
            if cases.is_empty() {
                return Ok(empty());
            }
            let age = crate::entity_wiring::min_grant_age_days(tx, p.org_id).await?;
            let facts: Vec<_> = cases
                .iter()
                .map(|c| SecondPersonQuery {
                    org: p.org_id,
                    feature: Feature::OrgChangeApply,
                    branch: None,
                    requester: UserId::from_uuid(c.requested_by),
                    excluded: c.excluded.iter().copied().map(UserId::from_uuid).collect(),
                    case_created_at: if c.status == "RECORDED" {
                        query.now
                    } else {
                        c.created_at
                    },
                    min_grant_age_days: age,
                })
                .collect();
            let eligibility = second_person_facts_in_tx(tx, &facts, Some(p.user_id)).await?;
            let holds = authorize_capability(&p, Action::new(Feature::OrgChangeApply)).is_ok();
            let mut items = Vec::new();
            for (case, fact) in cases.into_iter().zip(eligibility) {
                let kind = if case.status == "PENDING" && case.requested_by == *p.user_id.as_uuid() {
                    "identifier_correction_waiting"
                } else if case.status == "APPROVED" && case.requested_by == *p.user_id.as_uuid()
                {
                    "identifier_correction_apply"
                } else if holds && fact.eligible.contains(p.user_id.as_uuid()) {
                    if case.status == "PENDING" {
                        "identifier_correction_decide"
                    } else if case.status == "RECORDED" {
                        "identifier_correction_review"
                    } else {
                        continue;
                    }
                } else {
                    continue;
                };
                items.push(ActionInboxSourceItem {
                    context: Some(serde_json::json!({"correction": {"status": case.status}})),
                    id: format!("identifier_correction:{}", case.id),
                    kind: kind.into(),
                    ref_code: String::new(),
                    title: case.entity_name,
                    site: None,
                    who: Some(case.requester_name),
                    due: Some(case.review_due_at.unwrap_or(case.expires_at)),
                    submitted: Some(case.created_at),
                    created_at: case.created_at,
                    links: vec![ActionInboxLink {
                        kind: "identifier_correction".into(),
                        id: case.id.to_string(),
                        label: None,
                    }],
                });
            }
            let total = items.len();
            items.sort_by(|a, b| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| a.id.cmp(&b.id))
            });
            if let Some(after) = query.after {
                items.retain(|i| {
                    i.created_at > after.created_at
                        || i.created_at == after.created_at && i.id > after.id
                });
            }
            let has_more = items.len() > query.limit;
            items.truncate(query.limit);
            Ok(ActionInboxSourcePage {
                items,
                total,
                total_is_exact: true,
                has_more,
            })
        })
    })
    .await.map_err(crate::entity_wiring::governance_kernel)
}
