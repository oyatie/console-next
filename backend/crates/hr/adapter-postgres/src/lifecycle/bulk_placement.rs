// SPDX-License-Identifier: LicenseRef-Proprietary
//! The initial legal placement accompanying a bulk transfer, in the same transaction.
use console_entity_adapter_postgres::employment_hire::{initial_placement_start, unit_placement};
use console_entity_adapter_postgres::employment_moves::open_workplace_entity;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::ChangeMode;
use sqlx::{Postgres, Transaction};
use time::Date;
use uuid::Uuid;

use super::prepare::PreparedLifecycleEvent;
use super::title_reason::coded;
use crate::HrError;

pub(super) struct InitialPlacement {
    pub workplace: Uuid,
    pub from: Date,
}

pub(super) async fn initial_placement(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
    prepared: &PreparedLifecycleEvent,
) -> Result<Option<InitialPlacement>, HrError> {
    if prepared.transition.event_type != "TRANSFER" {
        return Ok(None);
    }
    let Some(unit) = prepared.transition.to_org_unit_id else {
        return Ok(None);
    };
    let (hire, placed): (Option<String>, bool) = sqlx::query_as(
        "SELECT hire_date, EXISTS (SELECT 1 FROM employment_assignments a \
         WHERE a.org_id=e.org_id AND a.employee_id=e.id AND a.superseded_at IS NULL) \
         FROM person_employees_current e WHERE e.org_id=$1 AND e.id=$2",
    )
    .bind(org)
    .bind(employee)
    .fetch_one(tx.as_mut())
    .await?;
    if placed {
        return Ok(None);
    }
    let Some(at) = unit_placement(tx.as_mut(), org, unit)
        .await
        .map_err(coded)?
    else {
        return Ok(None);
    };
    let effective = parse_yyyy_mm_dd(&prepared.transition.effective_date)?;
    let from = if prepared.change_mode == Some(ChangeMode::Setup) {
        let hire = hire
            .as_deref()
            .and_then(|date| parse_yyyy_mm_dd(date).ok())
            .unwrap_or(effective);
        initial_placement_start(tx.as_mut(), at.workplace_id, hire)
            .await
            .map_err(coded)?
    } else {
        effective
    };
    open_workplace_entity(tx.as_mut(), org, at.workplace_id, Some(from))
        .await
        .map_err(coded)?;
    Ok(Some(InitialPlacement {
        workplace: at.workplace_id,
        from,
    }))
}
