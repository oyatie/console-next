//! The branch that backs a 사업장 (design §3.6, INTEG-5).

use console_entity_domain::Refusal;
use uuid::Uuid;

use crate::{PgEntityError, Tx};

/// The branch backing a 사업장 (design §3.6). Never matched by name
/// (INTEG-5): a same-named branch may carry someone's scope. An explicit
/// `default_branch_id` binds an existing open, unbound branch; otherwise a
/// new branch is created in the entity's region (found by id through its
/// other 사업장) or in a new region named after the entity. Names are unique
/// (regions per tenant, branches per region), so a taken name gets 「 (2)」.
pub(crate) async fn default_branch(
    tx: &mut Tx<'_>,
    entity: Uuid,
    entity_label: &str,
    name: &str,
    explicit: Option<Uuid>,
) -> Result<Uuid, PgEntityError> {
    // adopting a legacy 지점 here leaves its `('branch', id)`
    // source binding on the old name-only anchor unit (0263 re-pointed only
    // the branches that already backed a 사업장). Re-point it to the 사업장's
    // SITE unit through the canonical owner's port when an adoption UI ships.
    if let Some(branch) = explicit {
        let free: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM branches b WHERE b.id = $1 AND b.deactivated_at IS NULL \
               AND NOT EXISTS (SELECT 1 FROM workplaces w WHERE w.default_branch_id = b.id AND w.voided_at IS NULL))",
        )
        .bind(branch)
        .fetch_one(tx.as_mut())
        .await?;
        return if free {
            Ok(branch)
        } else {
            Err(Refusal::field("default_branch_id", "branch_unavailable").into())
        };
    }
    let region: Option<Uuid> = sqlx::query_scalar(
        "SELECT b.region_id FROM workplaces w JOIN branches b ON b.id = w.default_branch_id \
         WHERE w.legal_entity_id = $1 AND w.voided_at IS NULL ORDER BY w.created_at, w.id LIMIT 1",
    )
    .bind(entity)
    .fetch_optional(tx.as_mut())
    .await?;
    let region = match region {
        Some(id) => id,
        None => {
            sqlx::query_scalar(
                "WITH names AS (SELECT i, CASE WHEN i = 1 THEN $1 ELSE $1 || ' (' || i || ')' END AS n \
                                FROM generate_series(1, 100) AS i) \
                 INSERT INTO regions (name, org_id) \
                 SELECT n, NULLIF(current_setting('app.current_org', true), '')::uuid FROM names \
                 WHERE NOT EXISTS (SELECT 1 FROM regions r WHERE r.name = names.n) ORDER BY i LIMIT 1 RETURNING id",
            )
            .bind(entity_label)
            .fetch_one(tx.as_mut())
            .await?
        }
    };
    Ok(sqlx::query_scalar(
        "WITH names AS (SELECT i, CASE WHEN i = 1 THEN $2 ELSE $2 || ' (' || i || ')' END AS n \
                        FROM generate_series(1, 100) AS i) \
         INSERT INTO branches (region_id, name, org_id) \
         SELECT $1, n, NULLIF(current_setting('app.current_org', true), '')::uuid FROM names \
         WHERE NOT EXISTS (SELECT 1 FROM branches b WHERE b.region_id = $1 AND b.name = names.n) \
         ORDER BY i LIMIT 1 RETURNING id",
    )
    .bind(region)
    .bind(name)
    .fetch_one(tx.as_mut())
    .await?)
}
