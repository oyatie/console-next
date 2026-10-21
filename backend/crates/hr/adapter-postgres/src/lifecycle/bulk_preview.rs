//! `POST /employees/lifecycle-events/bulk/preview` (EMP-UI 8, spec E6): the
//! batch's exact counts before the commit, by the commit's own validation
//! (`bulk_plan`), writing nothing and auditing nothing.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::Serialize;
use serde_json::Value;

use super::bulk_plan::{bulk_input, plan_bulk};
use super::requests::BulkEmployeeLifecycleEventRequest;
use crate::authz::authorize_hr_org_wide;
use crate::clock::today_kst;
use crate::{HrError, HrService};

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct BulkLifecycleCounts {
    /// Distinct employees the batch names.
    pub selected: usize,
    /// Recorded APPLIED by a commit now (the date is today or earlier, KST).
    pub will_apply: usize,
    /// Recorded SCHEDULED for the date by a commit now.
    pub will_schedule: usize,
    /// Refused: a commit now answers 422 `bulk_lifecycle_refused` with these.
    pub refused: usize,
}

#[derive(Debug, Serialize)]
pub struct BulkLifecyclePreview {
    pub event_type: String,
    pub effective_date: String,
    /// The date is after today (KST): the whole batch is a reservation.
    pub scheduled: bool,
    pub counts: BulkLifecycleCounts,
    /// `{employee_id, code, message}` per refused employee.
    pub refusals: Vec<Value>,
}

impl HrService {
    /// The commit's validation, read-only, behind the commit's gate.
    pub async fn preview_bulk_lifecycle_events(
        &self,
        principal: Principal,
        body: BulkEmployeeLifecycleEventRequest,
    ) -> Result<BulkLifecyclePreview, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let input = bulk_input(body)?;
        let (org, scope, today) = (
            principal.org_id,
            principal.branch_scope.clone(),
            today_kst(),
        );
        let scheduled =
            console_hr_domain::text::parse_yyyy_mm_dd(&input.transition.effective_date)? > today;
        // the preview takes the commit's row locks for its short
        // read transaction (prepare locks each employee); a lock-free prepare
        // comes if a 3,000-person preview ever contends with live writes.
        let plan = with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                plan_bulk(tx, org, &input, &scope, today)
                    .await
                    .map(|p| (p, input))
            })
        })
        .await;
        let (plan, input) = plan?;
        let refused = plan.refusals.len();
        let ok = plan.loaded.len();
        Ok(BulkLifecyclePreview {
            event_type: input.transition.event_type,
            effective_date: input.transition.effective_date,
            scheduled,
            counts: BulkLifecycleCounts {
                selected: ok + refused,
                will_apply: if scheduled { 0 } else { ok },
                will_schedule: if scheduled { ok } else { 0 },
                refused,
            },
            refusals: plan.refusals,
        })
    }
}
