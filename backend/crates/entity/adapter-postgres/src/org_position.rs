//! A 부서 created as part of an outline (a create named by a `ref`: a paste or
//! an import) goes after its siblings (UX-R3 org-13): when any sibling has no
//! 순서 yet, the order the chart shows (순서, then name) is written down first,
//! then the new unit takes the next place. A pasted outline thus keeps its typed
//! order instead of falling back to name order (연구10실 before 연구1실).

use uuid::Uuid;

use crate::{PgEntityError, Tx};

/// Place `unit` last among the live children of `parent`.
pub(crate) async fn append(
    tx: &mut Tx<'_>,
    parent: Uuid,
    unit: Uuid,
    actor: Uuid,
) -> Result<(), PgEntityError> {
    sqlx::query(
        "WITH heads AS (SELECT DISTINCT ON (org_unit_id) org_unit_id, attributes FROM org_unit_revisions \
                        ORDER BY org_unit_id, version DESC), \
              sibs AS (SELECT h.org_unit_id AS id, p.position, h.attributes->>'name' AS name FROM heads h \
                       LEFT JOIN org_unit_positions p ON p.org_unit_id = h.org_unit_id \
                       WHERE h.attributes->>'parent_id' = $1::text AND h.org_unit_id <> $2 \
                         AND h.attributes->>'status' IS DISTINCT FROM 'dissolved'), \
              placed AS (SELECT id, (row_number() OVER (ORDER BY position IS NULL, position, name COLLATE \"C\") - 1)::int AS n \
                         FROM sibs UNION ALL SELECT $2, (SELECT count(*) FROM sibs)::int) \
         INSERT INTO org_unit_positions (org_id, org_unit_id, position, updated_by) \
         SELECT NULLIF(current_setting('app.current_org', true), '')::uuid, id, n, $3 FROM placed \
         ON CONFLICT (org_id, org_unit_id) DO UPDATE \
           SET position = EXCLUDED.position, updated_by = EXCLUDED.updated_by, updated_at = now()",
    )
    .bind(parent)
    .bind(unit)
    .bind(actor)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
