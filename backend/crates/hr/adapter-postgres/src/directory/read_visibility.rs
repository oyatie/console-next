// SPDX-License-Identifier: LicenseRef-Proprietary
//! Visibility scope and facet groups shared across `GET /employees` reads.

use console_platform_authz::{
    Feature, Principal,
    cedar_pbac::visible::{EmployeeVisibility, load_facts},
};
use sqlx::{Postgres, QueryBuilder};

use crate::HrError;
use crate::authz::{HrReach, push_reach};

/// The Cedar-decided visibility of `feature`, for a reader holding it by grant.
pub(crate) async fn visibility(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    principal: &Principal,
    feature: Feature,
) -> Result<Option<EmployeeVisibility>, HrError> {
    if !principal.is_tenant_ops && principal.scopes_for(feature).next().is_none() {
        return Ok(None);
    }
    let facts = load_facts(tx, principal.org_id, *principal.user_id.as_uuid())
        .await
        .map_err(HrError::from_kernel)?;
    facts
        .visible_employees(feature.as_str())
        .map(Some)
        .map_err(|e| HrError::internal(e.to_string()))
}

pub(crate) fn push_within(
    builder: &mut QueryBuilder<Postgres>,
    reach: &HrReach,
    visibility: &Option<EmployeeVisibility>,
) {
    match visibility {
        Some(visibility) => visibility.push(builder),
        None => push_reach(builder, reach),
    }
}

/// The filter groups a facet chip lifts: each group is counted with every
/// filter except its own (`read_facets`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FacetGroup {
    Status,
    LegalEntity,
    Workplace,
    /// Needs-review flags and the contract window.
    Review,
}

impl FacetGroup {
    pub(crate) const ALL: [Self; 4] = [
        Self::Status,
        Self::LegalEntity,
        Self::Workplace,
        Self::Review,
    ];
}
