// SPDX-License-Identifier: LicenseRef-Proprietary
//! Employee-number shape and per-tenant allocation shared by registration writers.
use console_ontology_canonical_adapter_postgres::employee_void::include_voided;
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;

const EMPLOYEE_NUMBER_SHAPE: (&str, usize, usize) = ("E-", 6, 18);

pub fn format_employee_number(sequence: i64) -> String {
    let (prefix, width, _) = EMPLOYEE_NUMBER_SHAPE;
    format!("{prefix}{sequence:0width$}")
}

pub fn sequence_of(number: &str) -> Option<i64> {
    let (prefix, minimum, maximum) = EMPLOYEE_NUMBER_SHAPE;
    let digits = number.strip_prefix(prefix)?;
    if !(minimum..=maximum).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// The next server-assigned employee number: `E-` and a zero-padded per-tenant
/// sequence (`E-000001`, `E-000002`, …), one past the highest number of that
/// shape in the tenant (a manual number of the same shape moves the sequence
/// past it, so the two never collide). A per-tenant advisory lock held to
/// commit serializes concurrent assignments.
pub async fn next_employee_number(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
) -> Result<String, HrError> {
    Ok(format_employee_number(
        next_employee_sequence(tx, org_uuid).await?,
    ))
}

pub async fn next_employee_sequence(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
) -> Result<i64, HrError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('employee_number_seq:' || $1::text))")
        .bind(org_uuid)
        .execute(tx.as_mut())
        .await?;
    // Voided registrations and retired aliases keep their issued numbers.
    include_voided(tx, true).await?;
    let last: Option<i64> = sqlx::query_scalar(
        "SELECT max(substr(n, $2)::BIGINT) FROM ( \
           SELECT employee_number AS n FROM employees WHERE org_id = $1 \
           UNION ALL SELECT from_number FROM employee_number_changes WHERE org_id = $1 \
           UNION ALL SELECT to_number FROM employee_number_changes WHERE org_id = $1) used \
         WHERE n ~ $3",
    )
    .bind(org_uuid)
    .bind((EMPLOYEE_NUMBER_SHAPE.0.len() + 1) as i32)
    .bind(format!(
        "^{}[0-9]{{{},{}}}$",
        EMPLOYEE_NUMBER_SHAPE.0, EMPLOYEE_NUMBER_SHAPE.1, EMPLOYEE_NUMBER_SHAPE.2
    ))
    .fetch_one(tx.as_mut())
    .await?;
    include_voided(tx, false).await?;
    Ok(last.unwrap_or(0) + 1)
}

#[cfg(test)]
mod tests {
    use super::{format_employee_number, sequence_of};

    #[test]
    fn employee_number_shape_preserves_padding_and_sequence_boundaries() {
        for (sequence, number) in [
            (1, "E-000001"),
            (1_000_000, "E-1000000"),
            (999_999_999_999_999_999, "E-999999999999999999"),
        ] {
            assert_eq!(format_employee_number(sequence), number);
            assert_eq!(sequence_of(number), Some(sequence));
        }
        assert_eq!(sequence_of("E-0000001"), Some(1));
        for manual in [
            "E-1",
            "E-1000000000000000000",
            "E-１２３４５６",
            "E-+00001",
            "X-000001",
            "E-000001\n",
        ] {
            assert_eq!(sequence_of(manual), None, "{manual}");
        }
    }
}
