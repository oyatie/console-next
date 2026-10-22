//! Composition for the 법인 · 사업장 (`console-entity-rest`) and setup-phase
//! (`console-onboarding-rest`) faces, kept out of `lib.rs` (R1) so the
//! router merge there is one line.
//!
//! The one seam that needs the composition root: setup-phase org units are
//! written by the canonical OrgUnit owner (`org_unit::write_in_tx`), inside
//! the entity adapter's transaction — one writer, one more caller, the same
//! shape as the org-change apply seam (`PgOrgUnitWritePort` in lib.rs).

use std::sync::Arc;

use axum::Router;
use console_entity_adapter_juso::JusoClient;
use console_entity_adapter_postgres::{OrgUnitSetupFuture, OrgUnitSetupWritePort, PgEntityStore};
use console_entity_rest::EntityRestState;
use console_kernel_core::{KernelError, OrgId, UserId};
use console_onboarding_adapter_postgres::PgOnboardingStore;
use console_onboarding_rest::OnboardingRestState;
use console_ontology_canonical_adapter_postgres::org_unit::{
    OrgUnitCommand, OrgUnitError, OrgUnitQuery, write_in_tx,
};
use console_platform_auth::{JwtVerifier, PasskeyService};
use sqlx::PgPool;

mod correction_register;
mod corrections;
mod exceptions;
use corrections::GovernedIdentifierCorrections;
pub(crate) use exceptions::read_correction_outcome;

struct CanonicalOrgUnitSetupPort;

impl OrgUnitSetupWritePort for CanonicalOrgUnitSetupPort {
    fn write<'tx>(
        &self,
        tx: &'tx mut sqlx::Transaction<'_, sqlx::Postgres>,
        org: OrgId,
        actor: UserId,
        command_id: uuid::Uuid,
        org_unit_id: Option<uuid::Uuid>,
        attributes: serde_json::Value,
    ) -> OrgUnitSetupFuture<'tx> {
        Box::pin(async move {
            let (query, action_key) = match org_unit_id {
                None => (
                    OrgUnitQuery::Create {
                        source: None,
                        attributes,
                    },
                    "internal.setup.create_org_unit",
                ),
                Some(org_unit_id) => (
                    OrgUnitQuery::Revise {
                        org_unit_id,
                        source: None,
                        attributes,
                    },
                    "internal.setup.revise_org_unit",
                ),
            };
            let command = OrgUnitCommand {
                org_id: org,
                command_id: console_ontology_canonical_domain::CommandId::from_uuid(command_id),
                actor_id: actor,
                query,
                action_key: action_key.to_owned(),
                object_type_id: uuid::Uuid::nil(),
            };
            let receipt = write_in_tx(tx, &command)
                .await
                .map_err(|error| match error {
                    OrgUnitError::Blocked(_) | OrgUnitError::DigestConflict(_) => {
                        KernelError::conflict(error.to_string())
                    }
                    OrgUnitError::Database(_) | OrgUnitError::UnreadableReceipt(_, _) => {
                        tracing::error!(error = %error, "org-unit write failed at the setup seam");
                        KernelError::internal("org-unit write failed")
                    }
                })?;
            receipt.result()["org_unit_id"]
                .as_str()
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .ok_or_else(|| KernelError::internal("org-unit receipt names no unit"))
        })
    }

    // --- lane: CRUD ---
    fn org_changes_routed<'tx>(
        &self,
        tx: &'tx mut sqlx::Transaction<'_, sqlx::Postgres>,
        org: OrgId,
    ) -> console_entity_adapter_postgres::RoutedFuture<'tx> {
        Box::pin(async move {
            console_settings_adapter_postgres::approval_routes_in_tx(
                tx.as_mut(),
                org,
                console_settings_domain::SettingKey::ApprovalPolicyOrgStructure,
            )
            .await
        })
    }
}

/// The canonical OrgUnit seam, for the lifecycle tick's 사업장 close step (UX-R2 ENDS).
pub(crate) fn org_unit_port() -> Arc<dyn OrgUnitSetupWritePort> {
    Arc::new(CanonicalOrgUnitSetupPort)
}

/// Both faces, ready to merge into the application router.
pub(crate) fn router(
    pool: PgPool,
    jwt: Option<JwtVerifier>,
    passkey: Option<PasskeyService>,
    juso: Arc<JusoClient>,
) -> Router {
    let exceptions = exceptions::router(pool.clone(), jwt.clone(), passkey.clone());
    let entity = console_entity_rest::router(
        EntityRestState::new(
            PgEntityStore::new(pool.clone()),
            jwt.clone(),
            Some(Arc::new(CanonicalOrgUnitSetupPort)),
        )
        .with_juso(juso)
        .with_governed_corrections(Arc::new(GovernedIdentifierCorrections {
            passkeys: passkey.clone(),
        })),
    )
    .layer(axum::Extension(
        console_platform_request_context::record_access::outcome::Reader(
            exceptions::read_correction_outcome,
        ),
    ));
    let onboarding = console_onboarding_rest::router(OnboardingRestState::new(
        PgOnboardingStore::new(pool),
        jwt,
        passkey,
    ));
    entity.merge(onboarding).merge(exceptions)
}
