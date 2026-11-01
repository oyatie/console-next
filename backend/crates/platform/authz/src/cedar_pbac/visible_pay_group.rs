// SPDX-License-Identifier: LicenseRef-Proprietary
//! Record facts stay inside the canonical loader and the caller's RLS transaction.
use super::DecisionFacts;
use crate::{
    Feature,
    access::{AccessEngineError, Domain, Level, NodeKind, NodeRef, action_group},
};
use console_kernel_core::{KernelError, OrgId};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// Stored payroll record facts, supplied by the payroll adapter under tenant RLS.
pub struct PayGroupFact {
    pub id: Uuid,
    pub legal_entity_id: Uuid,
    pub sensitive: bool,
}

/// Payroll owns record storage; the canonical fact loader owns Cedar decisions.
pub trait PayGroupFactLoader {
    /// Refuse an unarmed/wrong tenant or bypass-RLS transaction.
    fn load_pay_group_facts(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        org: OrgId,
    ) -> impl Future<Output = Result<Vec<PayGroupFact>, KernelError>> + Send;
}

impl DecisionFacts {
    /// Creation evaluates the explicitly supplied sensitivity before anything is persisted.
    ///
    /// # Errors
    /// Any Cedar evaluation failure, which must refuse the command.
    pub fn authorize_pay_group_creation(
        &self,
        entity: Uuid,
        sensitive: bool,
    ) -> Result<bool, AccessEngineError> {
        self.pay_group_allowed(Feature::PayrollRunManage, entity, sensitive)
    }

    fn pay_group_allowed(
        &self,
        action: Feature,
        entity: Uuid,
        sensitive: bool,
    ) -> Result<bool, AccessEngineError> {
        let level = match action {
            Feature::PayrollRunRead => Level::View,
            Feature::PayrollRunManage => Level::Edit,
            _ => return Ok(false),
        };
        let resource = NodeRef {
            kind: NodeKind::LegalEntity,
            id: entity,
        };
        super::super::actions::pay_group::decide(
            &self.actor.to_string(),
            &self.org.to_string(),
            self.authorize(action.as_str(), resource)?,
            sensitive,
            self.authorize(&action_group(Domain::Sensitive, level), resource)?,
        )
        .map_err(AccessEngineError::Evaluation)
    }

    /// The stored flag, never a caller's projection, controls read/edit visibility.
    ///
    /// # Errors
    /// Missing RLS, database or Cedar errors; none can widen the allowed set.
    pub async fn visible_pay_groups(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        action: Feature,
        loader: &impl PayGroupFactLoader,
    ) -> Result<Vec<Uuid>, KernelError> {
        let groups = loader.load_pay_group_facts(tx, self.org).await?;
        let mut ids = Vec::new();
        for group in groups {
            if self
                .pay_group_allowed(action, group.legal_entity_id, group.sensitive)
                .map_err(|_| KernelError::unavailable("pay-group Cedar decision unavailable"))?
            {
                ids.push(group.id);
            }
        }
        Ok(ids)
    }
}
