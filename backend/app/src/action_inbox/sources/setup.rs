// SPDX-License-Identifier: LicenseRef-Proprietary
//! Reuse the authorized setup checklist; there is no second setup rule set.
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
};
use console_kernel_core::{ErrorKind, KernelError, TraceContext};
use console_onboarding_adapter_postgres::{OnboardingActor, PgOnboardingError, PgOnboardingStore};
use console_platform_authz::Principal;
use serde_json::Value;
use time::OffsetDateTime;

pub(crate) async fn load(
    pool: &sqlx::PgPool,
    principal: &Principal,
) -> Result<Option<Value>, KernelError> {
    let actor = OnboardingActor {
        org: principal.org_id,
        user: principal.user_id,
        roles: principal
            .roles
            .iter()
            .map(|r| r.as_str().to_owned())
            .collect(),
        trace: TraceContext::generate(),
    };
    let checklist = match PgOnboardingStore::new(pool.clone()).checklist(&actor).await {
        Ok(c) => c,
        Err(PgOnboardingError::Refused {
            kind: ErrorKind::Forbidden,
            ..
        }) => return Ok(None),
        Err(e) => {
            tracing::error!(error = ?e, "setup inbox source failed");
            return Err(KernelError::internal("failed to load setup work"));
        }
    };
    if checklist.phase != "SETUP" {
        return Ok(None);
    }
    serde_json::to_value(checklist)
        .map(Some)
        .map_err(|_| KernelError::internal("failed to project setup work"))
}

pub(crate) fn page(
    checklist: Option<&Value>,
    org: uuid::Uuid,
    created_at: OffsetDateTime,
    query: ActionInboxSourceQuery,
) -> ActionInboxSourcePage {
    let items: Vec<_> = checklist
        .and_then(|c| c["steps"].as_array())
        .into_iter()
        .flatten()
        .filter(|step| step["can_act"] == true && step["state"] != "done")
        .filter_map(|step| {
            let key = step["key"].as_str()?;
            Some(ActionInboxSourceItem {
                id: format!("setup_{key}:{org}"),
                kind: format!("setup_{key}"),
                ref_code: step["action"].as_str()?.into(),
                title: key.into(),
                site: None,
                who: None,
                due: None,
                submitted: None,
                created_at,
                links: vec![ActionInboxLink {
                    kind: "setup".into(),
                    id: key.into(),
                    label: None,
                }],
            })
        })
        .filter(|i| i.created_at <= query.as_of)
        .collect();
    let total = items.len();
    let mut visible: Vec<_> = items
        .into_iter()
        .filter(|item| {
            query
                .after
                .as_ref()
                .is_none_or(|p| (item.created_at, &item.id) > (p.created_at, &p.id))
        })
        .collect();
    visible.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let has_more = visible.len() > query.limit;
    visible.truncate(query.limit);
    ActionInboxSourcePage {
        items: visible,
        total,
        total_is_exact: true,
        has_more,
    }
}
