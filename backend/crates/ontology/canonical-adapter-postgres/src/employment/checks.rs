// SPDX-License-Identifier: LicenseRef-Proprietary
//! Canonical write checks, with reference and date reuse inside one tenant transaction.
use std::collections::BTreeSet;

use super::{EmploymentCommand, EmploymentError, PgEmploymentPort};
use super::{change_window, lookups::ensure_attribute_refs};
use console_ontology_canonical_domain::CanonicalPort;
use sqlx::{Postgres, Transaction};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

pub(super) fn check_preflight(command: &EmploymentCommand) -> Result<(), EmploymentError> {
    let preflight = <PgEmploymentPort as CanonicalPort>::preflight(&command.query);
    if !preflight.is_ok() {
        return Err(EmploymentError::Blocked(preflight.blockers().to_vec()));
    }
    Ok(())
}

#[derive(Default)]
pub(super) struct WriteChecks {
    refs: BTreeSet<(Option<Uuid>, Option<Uuid>)>,
    dates: BTreeSet<Date>,
}

impl WriteChecks {
    pub(super) async fn check(
        &mut self,
        tx: &mut Transaction<'_, Postgres>,
        command: &EmploymentCommand,
    ) -> Result<(), EmploymentError> {
        check_preflight(command)?;
        let org = *command.org_id.as_uuid();
        let attrs = command.query.attributes();
        if !self
            .refs
            .contains(&(attrs.org_unit_id, attrs.job_position_id))
        {
            ensure_attribute_refs(tx, org, attrs).await?;
            self.refs.insert((attrs.org_unit_id, attrs.job_position_id));
        }
        self.check_date(tx, org, command.query.valid_from()).await
    }

    pub(super) async fn check_date(
        &mut self,
        tx: &mut Transaction<'_, Postgres>,
        org: Uuid,
        valid_from: OffsetDateTime,
    ) -> Result<(), EmploymentError> {
        let date = change_window::business_date(valid_from);
        if !self.dates.contains(&date) {
            change_window::assert_employment_change_window_open(tx, org, date).await?;
            self.dates.insert(date);
        }
        Ok(())
    }
}
