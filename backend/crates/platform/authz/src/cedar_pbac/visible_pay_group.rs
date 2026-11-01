// SPDX-License-Identifier: LicenseRef-Proprietary
//! Record facts stay inside the canonical loader and the caller's RLS transaction.
use super::{DecisionFacts, db};
use crate::{
    Feature,
    access::{AccessEngineError, Domain, Level, NodeKind, NodeRef, action_group},
};
use console_kernel_core::KernelError;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

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
    ) -> Result<Vec<Uuid>, KernelError> {
        let armed: bool = sqlx::query_scalar(
            "SELECT COALESCE(current_setting('app.current_org', true)=$1,false)
             AND row_security_active('pay_groups')",
        )
        .bind(self.org.to_string())
        .fetch_one(tx.as_mut())
        .await
        .map_err(db)?;
        if !armed {
            return Err(KernelError::forbidden("pay-group facts require tenant RLS"));
        }
        let groups: Vec<(Uuid, Uuid, bool)> =
            sqlx::query_as("SELECT id,legal_entity_id,sensitive FROM pay_groups WHERE org_id=$1")
                .bind(self.org.as_uuid())
                .fetch_all(tx.as_mut())
                .await
                .map_err(db)?;
        let mut ids = Vec::new();
        for (id, entity, sensitive) in groups {
            if self
                .pay_group_allowed(action, entity, sensitive)
                .map_err(|_| KernelError::unavailable("pay-group Cedar decision unavailable"))?
            {
                ids.push(id);
            }
        }
        Ok(ids)
    }
}
