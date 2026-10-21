use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{
    BranchSummary, CreateBranchCommand, CreateRegionCommand, DeactivateBranchCommand,
    DeactivateRegionCommand, RegionSummary, UpdateBranchCommand, UpdateRegionCommand,
};
use console_kernel_core::{BranchId, KernelError, RegionId};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use sqlx::Row;

fn direct_org_structure_mutation_refused() -> PgOrgError {
    KernelError::forbidden(
        "direct region/branch mutation is disabled; submit an OrgProposal instead",
    )
    .into()
}

impl PgOrgStore {
    /// Retired direct-write entry point. The compatibility HTTP method now
    /// creates an org-change draft; keeping this tombstone makes any stale
    /// in-process caller fail closed before tenant lookup or SQL.
    pub async fn create_region(
        &self,
        _command: CreateRegionCommand,
    ) -> Result<RegionSummary, PgOrgError> {
        Err(direct_org_structure_mutation_refused())
    }

    /// Retired direct-write entry point; see [`Self::create_region`].
    pub async fn update_region(
        &self,
        _command: UpdateRegionCommand,
    ) -> Result<RegionSummary, PgOrgError> {
        Err(direct_org_structure_mutation_refused())
    }

    /// Retired direct-write entry point; the orgchange apply path owns the
    /// active-branch referential guard and the eventual soft delete.
    pub async fn deactivate_region(
        &self,
        _command: DeactivateRegionCommand,
    ) -> Result<RegionSummary, PgOrgError> {
        Err(direct_org_structure_mutation_refused())
    }

    /// List ACTIVE regions (deactivated rows are hidden from the org tree and the
    /// pickers). Ordered by name for a stable console listing.
    pub async fn list_regions(&self) -> Result<Vec<RegionSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(
                    "SELECT id, name, deactivated_at, created_at FROM regions \
                     WHERE deactivated_at IS NULL ORDER BY name",
                )
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;
        rows.iter().map(region_from_row).collect()
    }

    /// Retired direct-write entry point. The compatibility HTTP method now
    /// creates an org-change draft and never inserts a live branch.
    pub async fn create_branch(
        &self,
        _command: CreateBranchCommand,
    ) -> Result<BranchSummary, PgOrgError> {
        Err(direct_org_structure_mutation_refused())
    }

    /// Retired direct-write entry point; see [`Self::create_branch`].
    pub async fn update_branch(
        &self,
        _command: UpdateBranchCommand,
    ) -> Result<BranchSummary, PgOrgError> {
        Err(direct_org_structure_mutation_refused())
    }

    /// Retired direct-write entry point; the orgchange apply path owns the
    /// dependent-user/equipment guards and the eventual soft delete.
    pub async fn deactivate_branch(
        &self,
        _command: DeactivateBranchCommand,
    ) -> Result<BranchSummary, PgOrgError> {
        Err(direct_org_structure_mutation_refused())
    }

    /// List ACTIVE branches (deactivated rows are hidden). Used both for org setup
    /// and support-ticket triage.
    pub async fn list_branches(&self) -> Result<Vec<BranchSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(
                    "SELECT id, region_id, name, deactivated_at, created_at FROM branches \
                     WHERE deactivated_at IS NULL ORDER BY name",
                )
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;
        rows.iter().map(branch_from_row).collect()
    }
}

fn region_from_row(row: &sqlx::postgres::PgRow) -> Result<RegionSummary, PgOrgError> {
    Ok(RegionSummary {
        id: RegionId::from_uuid(row.try_get("id")?),
        name: row.try_get("name")?,
        deactivated_at: row.try_get("deactivated_at")?,
        created_at: row.try_get("created_at")?,
    })
}

fn branch_from_row(row: &sqlx::postgres::PgRow) -> Result<BranchSummary, PgOrgError> {
    Ok(BranchSummary {
        id: BranchId::from_uuid(row.try_get("id")?),
        region_id: RegionId::from_uuid(row.try_get("region_id")?),
        name: row.try_get("name")?,
        deactivated_at: row.try_get("deactivated_at")?,
        created_at: row.try_get("created_at")?,
    })
}
