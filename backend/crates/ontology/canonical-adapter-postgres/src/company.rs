// SPDX-License-Identifier: LicenseRef-Proprietary
//! Retired company writer: legal facts belong to the entity adapter and tenant
//! names to the existing operator owner. Legacy receipts remain replayable.
//! Existing revisions and receipts stay immutable during the expand phase.

use console_kernel_core::{KernelError, OrgId, UserId};
use console_ontology_canonical_domain::{
    CanonicalPort, CanonicalPortError, CanonicalQuery, CommandId, CommandReceipt, Company,
    DispatchTarget, ObjectKey, Preflight, ReceiptOwner,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::str::FromStr;
use time::OffsetDateTime;
use uuid::Uuid;

/// The typed read this port answers: the write a caller intends, and nothing
/// about how it is performed.
///
/// A STRUCT, not an enum. `Company` has exactly one dispatch target in the
/// contract — `company.revise` — so a one-variant enum would be a `match` with
/// a single arm in every method, and `the_contract_identity_is_copied_verbatim…`
/// asserts that one-ness against `DispatchTarget::ALL` so a second target makes
/// the test fail rather than this shape silently go wrong.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CompanyQuery {
    /// Legacy attributes, retained for replay of commands accepted before retirement.
    pub attributes: serde_json::Value,
}

impl CompanyQuery {
    /// The dispatch target this query is, spelled once in `canonical-domain`.
    #[must_use]
    pub const fn target(&self) -> DispatchTarget {
        DispatchTarget::CompanyRevise
    }
}

impl CanonicalQuery for CompanyQuery {
    fn dispatch_target(&self) -> DispatchTarget {
        self.target()
    }

    fn subject_id(&self) -> Option<Uuid> {
        // Company revise is the tenant itself (`org_id`), not a payload row id.
        None
    }
}

/// A legacy command with its original tenant-global idempotency key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanyCommand {
    pub org_id: OrgId,
    pub command_id: CommandId,
    pub actor_id: UserId,
    pub query: CompanyQuery,
    pub action_key: String,
    pub object_type_id: Uuid,
}

#[derive(Debug, thiserror::Error)]
pub enum CompanyError {
    #[error("{code}", code = crate::catalog::LEGAL_ENTITY_RECORD_REQUIRED)]
    LegalEntityRecordRequired,
    #[error("preflight blocked the command: {0:?}")]
    Blocked(Vec<String>),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("command {0} was already applied with a different payload")]
    DigestConflict(Uuid),
    #[error("stored receipt for command {0} names no dispatch target: {1}")]
    UnreadableReceipt(Uuid, String),
}

impl CanonicalPortError for CompanyError {
    fn into_kernel_error(self) -> KernelError {
        let message = self.to_string();
        match self {
            Self::LegalEntityRecordRequired => KernelError::validation(message)
                .with_code(crate::catalog::LEGAL_ENTITY_RECORD_REQUIRED),
            Self::Blocked(_) => KernelError::validation(message),
            Self::DigestConflict(_) => KernelError::conflict(message),
            Self::Database(_) | Self::UnreadableReceipt(_, _) => KernelError::internal(message),
        }
    }
}

/// Current tenant display name; legal facts are read on the legal-entity record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanyHead {
    pub org_id: Uuid,
    pub display_name: Option<String>,
    pub version: i64,
}

/// Compatibility port: replay history, refuse fresh writes, read tenant names.
#[derive(Debug, Clone)]
pub struct PgCompanyPort {
    pool: PgPool,
    runtime: tokio::runtime::Handle,
}

impl PgCompanyPort {
    #[must_use]
    pub const fn new(pool: PgPool, runtime: tokio::runtime::Handle) -> Self {
        Self { pool, runtime }
    }

    /// Current tenant display name. An invisible org yields no head.
    pub fn get(&self, org_id: OrgId) -> Result<Option<CompanyHead>, CompanyError> {
        self.runtime.block_on(self.read_head(*org_id.as_uuid()))
    }

    /// Zero or one current company head for the armed tenant.
    pub fn list(&self, org_id: OrgId) -> Result<Vec<CompanyHead>, CompanyError> {
        self.runtime
            .block_on(self.read_head(*org_id.as_uuid()))
            .map(|head| head.into_iter().collect())
    }

    async fn arm_org<'e, E>(&self, executor: E, org: Uuid) -> Result<(), CompanyError>
    where
        E: sqlx::Executor<'e, Database = sqlx::Postgres>,
    {
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org.to_string())
            .execute(executor)
            .await?;
        Ok(())
    }

    async fn read_head(&self, org: Uuid) -> Result<Option<CompanyHead>, CompanyError> {
        let mut tx = self.pool.begin().await?;
        self.arm_org(&mut *tx, org).await?;
        let row = sqlx::query(
            "SELECT o.id AS org_id, o.name, COALESCE((SELECT MAX(version) FROM company_revisions WHERE org_id=o.id),0) AS version FROM organizations o WHERE o.id=$1",
        ).bind(org).fetch_optional(&mut *tx).await?;
        tx.commit().await?;
        Ok(row.map(|row| CompanyHead {
            org_id: row.get("org_id"),
            display_name: Some(row.get("name")),
            version: row.get("version"),
        }))
    }

    async fn write(&self, command: &CompanyCommand) -> Result<CommandReceipt, CompanyError> {
        let digest = payload_digest(command);
        let org = *command.org_id.as_uuid();
        let command_uuid = *command.command_id.as_uuid();

        let mut tx = self.pool.begin().await?;
        // Transaction-local, so it is cleared on COMMIT/ROLLBACK and never
        // leaks to the next checkout of a pooled connection. Unset fails
        // closed: RLS shows no rows and accepts no writes.
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org.to_string())
            .execute(&mut *tx)
            .await?;

        if let Some(stored) = sqlx::query(
            "SELECT actor_id, payload_digest, receipt, created_at \
             FROM ont_action_command_receipts WHERE org_id = $1 AND command_id = $2",
        )
        .bind(org)
        .bind(command_uuid)
        .fetch_optional(&mut *tx)
        .await?
        {
            let stored_digest: Vec<u8> = stored.get("payload_digest");
            if stored_digest != digest {
                return Err(CompanyError::DigestConflict(command_uuid));
            }
            let result: serde_json::Value = stored.get("receipt");
            let target = stored_target(command_uuid, &result)?;
            let stored_actor: Uuid = stored.get("actor_id");
            let created_at: OffsetDateTime = stored.get("created_at");
            return Ok(receipt(
                command,
                target,
                UserId::from_uuid(stored_actor),
                digest,
                result,
                created_at,
            ));
        }

        Err(CompanyError::LegalEntityRecordRequired)
    }
}

impl CanonicalPort for PgCompanyPort {
    type Object = Company;
    type Query = CompanyQuery;
    type Command = CompanyCommand;
    type Error = CompanyError;

    /// PURE: no `&self`, no IO, no persistence. A blocked preflight has written
    /// nothing, so it can never spend an approval.
    fn preflight(_query: &Self::Query) -> Preflight {
        Preflight::blocked(vec![
            crate::catalog::LEGAL_ENTITY_RECORD_REQUIRED.to_owned(),
        ])
        .with_code(crate::catalog::LEGAL_ENTITY_RECORD_REQUIRED)
    }

    fn command(
        org_id: OrgId,
        command_id: CommandId,
        actor_id: UserId,
        query: Self::Query,
        action_key: &str,
        object_type_id: Uuid,
    ) -> Self::Command {
        CompanyCommand {
            org_id,
            command_id,
            actor_id,
            query,
            action_key: action_key.to_owned(),
            object_type_id,
        }
    }

    fn execute(&self, command: &Self::Command) -> Result<CommandReceipt, Self::Error> {
        self.runtime.block_on(self.write(command))
    }
}

fn receipt(
    command: &CompanyCommand,
    target: DispatchTarget,
    actor_id: UserId,
    digest: [u8; 32],
    result: serde_json::Value,
    created_at: OffsetDateTime,
) -> CommandReceipt {
    CommandReceipt::new(
        command.org_id,
        command.command_id,
        ReceiptOwner::Canonical(ObjectKey::Company),
        target,
        actor_id,
        digest,
        result,
        created_at,
    )
}

/// The target a stored receipt names, read back through the roster's `FromStr`
/// rather than re-spelled here.
fn stored_target(
    command_id: Uuid,
    result: &serde_json::Value,
) -> Result<DispatchTarget, CompanyError> {
    let stored = result["target"]
        .as_str()
        .ok_or_else(|| CompanyError::UnreadableReceipt(command_id, result.to_string()))?;
    DispatchTarget::from_str(stored)
        .map_err(|error| CompanyError::UnreadableReceipt(command_id, error.to_string()))
}

/// The 32 bytes the `payload_digest` CHECK is sized for.
///
/// The attributes go in through [`canonical_json`], never through
/// `Value::to_string()` directly: `serde_json` resolves with `preserve_order`
/// in this workspace, so a `Value` serialises its object keys in INSERTION
/// order and two payloads that compare EQUAL serialise to different bytes. The
/// retry a client performs after a timeout — or after a round-trip through the
/// `attributes` JSONB column, which PostgreSQL stores in its own key order —
/// must digest to the same 32 bytes, or it comes back as a
/// [`CompanyError::DigestConflict`] instead of the documented replay.
fn payload_digest(command: &CompanyCommand) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(command.org_id.as_uuid().as_bytes());
    hasher.update(command.command_id.as_uuid().as_bytes());
    hasher.update(command.actor_id.as_uuid().as_bytes());
    hasher.update(command.query.target().as_str().as_bytes());
    hasher.update(
        canonical_json(&command.query.attributes)
            .to_string()
            .as_bytes(),
    );
    hasher.finalize().into()
}

/// The same value with every object's keys SORTED, at every depth — the form
/// `Value::to_string()` would already emit if `serde_json` were not built with
/// `preserve_order`. The sort is explicit because collecting back into a `Map`
/// preserves the source's iteration order under that feature, so a rebuild that
/// does not sort is a no-op.
fn canonical_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(canonical_json).collect())
        }
        serde_json::Value::Object(values) => {
            let mut entries: Vec<(String, serde_json::Value)> = values
                .iter()
                .map(|(key, value)| (key.clone(), canonical_json(value)))
                .collect();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            serde_json::Value::Object(entries.into_iter().collect())
        }
        primitive => primitive.clone(),
    }
}

#[cfg(test)]
mod port_error_kind_tests {
    use super::*;
    use console_kernel_core::ErrorKind;
    use console_ontology_canonical_domain::CanonicalPortError;

    #[test]
    fn digest_conflict_is_conflict_not_internal() {
        let kernel = CompanyError::DigestConflict(Uuid::nil()).into_kernel_error();
        assert_eq!(kernel.kind, ErrorKind::Conflict);
    }

    #[test]
    fn blocked_is_validation_and_database_is_internal() {
        assert_eq!(
            CompanyError::Blocked(vec!["x".into()])
                .into_kernel_error()
                .kind,
            ErrorKind::Validation
        );
        assert_eq!(
            CompanyError::Database(sqlx::Error::RowNotFound)
                .into_kernel_error()
                .kind,
            ErrorKind::Internal
        );
    }
}
