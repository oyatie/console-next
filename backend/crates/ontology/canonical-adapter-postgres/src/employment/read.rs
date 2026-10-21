//! The port's reads: heads effective at an instant, and one employee's projection.

use super::error::EmploymentError;
use super::port::PgEmploymentPort;
use super::projection::{
    EmploymentEffectiveProjection, EmploymentEffectiveStatus, EmploymentHead,
    parse_effective_attributes,
};
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

impl PgEmploymentPort {
    pub(super) async fn read_heads(
        &self,
        org: Uuid,
        employment_id: Option<Uuid>,
        as_of: Option<OffsetDateTime>,
    ) -> Result<Vec<EmploymentHead>, EmploymentError> {
        let mut tx = self.pool.begin().await?;
        self.arm_org(&mut *tx, org).await?;
        let rows = sqlx::query(
            "WITH point_in_time AS MATERIALIZED ( \
               SELECT COALESCE($3::timestamptz, statement_timestamp()) AS at \
             ) \
             SELECT h.id, h.valid_from AS appointed_on, h.valid_to AS closed_at, \
                    t.at AS captured_as_of, r.valid_from AS revision_valid_from, \
                    r.attributes, \
                    bind.n AS binding_count, bind.person_id \
             FROM employment_heads h \
             CROSS JOIN point_in_time t \
             LEFT JOIN LATERAL ( \
               SELECT valid_from, attributes FROM employment_revisions \
               WHERE org_id = h.org_id AND employment_id = h.id \
                 AND valid_from <= t.at \
               ORDER BY valid_from DESC LIMIT 1 \
             ) r ON true \
             LEFT JOIN LATERAL ( \
               SELECT COUNT(*)::bigint AS n, (ARRAY_AGG(p.person_id))[1] AS person_id \
               FROM employment_source_bindings b \
               LEFT JOIN employee_person_bindings p \
                 ON p.org_id = b.org_id AND p.employee_id = b.employee_id \
               WHERE b.org_id = h.org_id AND b.employment_id = h.id \
             ) bind ON true \
             WHERE h.org_id = $1 AND ($2::uuid IS NULL OR h.id = $2) \
               AND h.valid_from <= t.at \
             ORDER BY h.id",
        )
        .bind(org)
        .bind(employment_id)
        .bind(as_of)
        .fetch_all(&mut *tx)
        .await?;
        let mut heads = Vec::new();
        for row in rows {
            let id: Uuid = row.get("id");
            let appointed_on: OffsetDateTime = row.get("appointed_on");
            let binding_count: i64 = row.get("binding_count");
            if binding_count != 1 {
                return Err(EmploymentError::AmbiguousSourceBinding {
                    employment_id: id,
                    binding_count: binding_count as usize,
                });
            }
            let revision_valid_from: Option<OffsetDateTime> = row.get("revision_valid_from");
            if revision_valid_from.is_some_and(|valid_from| valid_from < appointed_on) {
                return Err(EmploymentError::UnreadableEffectiveState {
                    employment_id: id,
                    reason: "revision predates relationship opening".to_owned(),
                });
            }
            let value: Option<serde_json::Value> = row.get("attributes");
            let value = value.ok_or_else(|| EmploymentError::UnreadableEffectiveState {
                employment_id: id,
                reason: "no effective revision after relationship opening".to_owned(),
            })?;
            let attributes = parse_effective_attributes(id, value)?;
            if attributes.employment_status != "ACTIVE" {
                continue;
            }
            let captured_as_of: OffsetDateTime = row.get("captured_as_of");
            let closed_at: Option<OffsetDateTime> = row.get("closed_at");
            if closed_at.is_some_and(|closed_at| closed_at <= captured_as_of) {
                return Err(EmploymentError::UnresolvedReactivation(id));
            }
            heads.push(EmploymentHead {
                id,
                person_id: row.get("person_id"),
                org_unit_id: attributes.org_unit_id,
                job_position_id: attributes.job_position_id,
                appointed_on,
            });
        }
        tx.commit().await?;
        Ok(heads)
    }

    pub(super) async fn read_effective(
        &self,
        org: Uuid,
        employee_id: Uuid,
        as_of: Option<OffsetDateTime>,
    ) -> Result<Option<EmploymentEffectiveProjection>, EmploymentError> {
        let mut tx = self.pool.begin().await?;
        self.arm_org(&mut *tx, org).await?;
        // The captured instant, binding, head and revision share one statement
        // snapshot. Do not filter on valid_to: EXITED remains a readable state.
        let row = sqlx::query(
            "WITH point_in_time AS MATERIALIZED ( \
               SELECT COALESCE($3::timestamptz, statement_timestamp()) AS at \
             ) \
             SELECT b.employment_id, h.valid_from AS opened_at, h.valid_to AS closed_at, \
                    t.at AS captured_as_of, r.valid_from AS revision_valid_from, \
                    r.attributes, \
                    (SELECT COUNT(*) FROM employment_source_bindings reverse_bind \
                     WHERE reverse_bind.org_id = b.org_id \
                       AND reverse_bind.employment_id = b.employment_id) AS binding_count \
             FROM employment_source_bindings b \
             JOIN employment_heads h \
               ON h.org_id = b.org_id AND h.id = b.employment_id \
             CROSS JOIN point_in_time t \
             LEFT JOIN LATERAL ( \
               SELECT valid_from, attributes FROM employment_revisions \
               WHERE org_id = b.org_id AND employment_id = b.employment_id \
                 AND valid_from <= t.at \
               ORDER BY valid_from DESC LIMIT 1 \
             ) r ON true \
             WHERE b.org_id = $1 AND b.employee_id = $2",
        )
        .bind(org)
        .bind(employee_id)
        .bind(as_of)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(None);
        };
        let employment_id = row.get("employment_id");
        let binding_count: i64 = row.get("binding_count");
        if binding_count != 1 {
            return Err(EmploymentError::AmbiguousSourceBinding {
                employment_id,
                binding_count: binding_count as usize,
            });
        }
        let captured_as_of: OffsetDateTime = row.get("captured_as_of");
        let opened_at: OffsetDateTime = row.get("opened_at");
        let closed_at: Option<OffsetDateTime> = row.get("closed_at");
        let revision_valid_from: Option<OffsetDateTime> = row.get("revision_valid_from");
        if revision_valid_from.is_some_and(|valid_from| valid_from < opened_at) {
            return Err(EmploymentError::UnreadableEffectiveState {
                employment_id,
                reason: "revision predates relationship opening".to_owned(),
            });
        }
        let attributes: Option<serde_json::Value> = row.get("attributes");
        let attributes = if captured_as_of < opened_at {
            if attributes.is_some() {
                return Err(EmploymentError::UnreadableEffectiveState {
                    employment_id,
                    reason: "revision predates relationship opening".to_owned(),
                });
            }
            None
        } else {
            let value = attributes.ok_or_else(|| EmploymentError::UnreadableEffectiveState {
                employment_id,
                reason: "no effective revision after relationship opening".to_owned(),
            })?;
            Some(parse_effective_attributes(employment_id, value)?)
        };
        let state = match attributes
            .as_ref()
            .map(|attributes| attributes.employment_status.as_str())
        {
            None => EmploymentEffectiveStatus::NotYetEffective,
            Some("ACTIVE") => EmploymentEffectiveStatus::Active,
            Some("ON_LEAVE") => EmploymentEffectiveStatus::OnLeave,
            Some("EXITED") => EmploymentEffectiveStatus::Exited,
            Some("UNKNOWN") => EmploymentEffectiveStatus::Unknown,
            Some(_) => {
                return Err(EmploymentError::UnreadableEffectiveState {
                    employment_id,
                    reason: "invalid employment status".to_owned(),
                });
            }
        };
        if state == EmploymentEffectiveStatus::Active
            && closed_at.is_some_and(|closed_at| closed_at <= captured_as_of)
        {
            return Err(EmploymentError::UnresolvedReactivation(employment_id));
        }
        let projection = EmploymentEffectiveProjection {
            employment_id,
            captured_as_of,
            state,
            is_active: state == EmploymentEffectiveStatus::Active,
            company: attributes.as_ref().map(|attrs| attrs.company.clone()),
            org_unit_id: attributes.as_ref().and_then(|attrs| attrs.org_unit_id),
            job_position_id: attributes.as_ref().and_then(|attrs| attrs.job_position_id),
        };
        tx.commit().await?;
        Ok(Some(projection))
    }
}
