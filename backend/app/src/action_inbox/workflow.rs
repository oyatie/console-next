// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use crate::workflow_studio;
use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, canonical_action_link_kind,
};
impl PgActionInboxSources {
    #[cfg(feature = "workspace")]
    pub(super) async fn workflow_page(
        &self,
        query: ActionInboxSourceQuery,
    ) -> Result<ActionInboxSourcePage, KernelError> {
        let after = query
            .after
            .as_ref()
            .map(|position| (position.due, position.created_at, position.id.clone()));
        let (tasks, has_more) = workflow_studio::my_action_inbox_tasks_page(
            &self.pool,
            &self.principal,
            query.as_of,
            after,
            query.limit,
        )
        .await
        .map_err(|error| source_failure("workflow", error))?;
        let (total, total_is_exact) =
            workflow_studio::my_action_inbox_task_count(&self.pool, &self.principal, query.as_of)
                .await
                .map_err(|error| source_failure("workflow", error))?;
        let items = tasks
            .into_iter()
            .map(|task| {
                let ref_code = task
                    .object_id
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| task.run_id.to_string());
                let links = if let (Some(object_type), Some(object_id)) =
                    (task.object_type, task.object_id)
                {
                    vec![ActionInboxLink {
                        kind: canonical_action_link_kind(&object_type).to_owned(),
                        id: object_id.to_string(),
                        label: None,
                    }]
                } else {
                    vec![ActionInboxLink {
                        kind: "approval_run".to_owned(),
                        id: task.run_id.to_string(),
                        label: None,
                    }]
                };
                ActionInboxSourceItem {
                    context: None,
                    id: format!("approval:{}", task.task_id),
                    kind: "approval".to_owned(),
                    ref_code,
                    title: task.title,
                    site: None,
                    who: None,
                    due: task.due_at,
                    submitted: None,
                    links,
                    created_at: task.created_at,
                }
            })
            .collect();
        Ok(ActionInboxSourcePage {
            items,
            total,
            total_is_exact,
            has_more,
        })
    }
}
