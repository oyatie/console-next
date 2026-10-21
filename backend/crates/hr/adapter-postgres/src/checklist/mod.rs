//! E10 onboarding checklist: loads the facts and derives the items
//! (`console_hr_domain::checklist`). Read only.

use console_hr_domain::checklist::{ChecklistEntry, OnboardingFacts, onboarding_checklist};
use console_hr_domain::contract::{in_force, live_history};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::Serialize;
use uuid::Uuid;

use crate::authz::authorize_hr_org_wide;
use crate::contract::load_rows;
use crate::metrics::record_hr_read;
use crate::profile::load_facts;
use crate::{HrError, HrService};

/// no `pending` (온보딩 queue membership) yet. It needs the window
/// setting `hr.onboarding.window_days` (`keys/emp_model.rs` from INT-6a);
/// `onboarding_pending` is ready for it. The items are complete without it.
#[derive(Debug, Clone, Serialize)]
pub struct OnboardingChecklist {
    pub employee_id: Uuid,
    pub items: Vec<ChecklistEntry>,
}

impl HrService {
    pub async fn onboarding_checklist(
        &self,
        principal: Principal,
        employee_id: Uuid,
    ) -> Result<OnboardingChecklist, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        record_hr_read("onboarding_checklist");
        let org_uuid = *principal.org_id.as_uuid();
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let facts = load_facts(tx, org_uuid, employee_id, false).await?;
                let rows = load_rows(tx, org_uuid, employee_id).await?;
                let hire_date = facts.hire();
                let contract_covers_hire = match hire_date {
                    Some(hire) => in_force(&rows, hire).is_some(),
                    None => !live_history(&rows).is_empty(),
                };
                let items = onboarding_checklist(&OnboardingFacts {
                    hire_date,
                    id_type: facts.id_type,
                    birth_date_recorded: facts.birth_date.is_some(),
                    pay_recorded: facts
                        .employment
                        .as_ref()
                        .is_some_and(|employment| employment.pay_unit.is_some()),
                    contract_covers_hire,
                });
                Ok(OnboardingChecklist { employee_id, items })
            })
        })
        .await
    }
}
