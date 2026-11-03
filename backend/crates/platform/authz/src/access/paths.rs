// SPDX-License-Identifier: LicenseRef-Proprietary

//! Build canonical access paths for departments.

use std::collections::BTreeMap;

use console_kernel_core::{KernelError, OrgId};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use uuid::Uuid;

use super::load::{db, scope_path};
use super::model::{NodeKind, NodePath, NodeRef};

pub(crate) struct DepartmentPath {
    pub current: NodePath,
    pub placement: Option<NodePath>,
}

/// The same canonical chains in one query; `None` loads every department.
pub(crate) async fn dept_paths(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    unit: Option<Uuid>,
) -> Result<BTreeMap<Uuid, DepartmentPath>, KernelError> {
    let rows = sqlx::query(
        "WITH RECURSIVE heads AS (SELECT DISTINCT ON (org_unit_id) org_unit_id, attributes \
            FROM org_unit_revisions WHERE org_id = $1 ORDER BY org_unit_id, version DESC), \
         up AS (SELECT org_unit_id AS root, org_unit_id, attributes, 0 AS depth FROM heads WHERE ($2::uuid IS NULL OR org_unit_id = $2) \
            UNION ALL SELECT u.root, h.org_unit_id, h.attributes, u.depth + 1 FROM heads h \
            JOIN up u ON h.org_unit_id::text = u.attributes->>'parent_id' WHERE u.depth < 64) \
         SELECT up.root, up.org_unit_id, up.attributes->>'status' = 'dissolved' AS dissolved, \
                p.workplace_id, COALESCE(p.represents_workplace, false) AS represents, w.legal_entity_id \
           FROM up LEFT JOIN org_unit_placements p ON p.org_id = $1 AND p.org_unit_id = up.org_unit_id \
                AND p.valid_to IS NULL AND p.workplace_id IS NOT NULL \
           LEFT JOIN workplaces w ON w.org_id = $1 AND w.id = p.workplace_id AND w.voided_at IS NULL \
          ORDER BY up.root, up.depth",
    )
    .bind(org.as_uuid())
    .bind(unit)
    .fetch_all(tx.as_mut())
    .await
    .map_err(db)?;
    let mut grouped: BTreeMap<Uuid, Vec<PgRow>> = BTreeMap::new();
    for row in rows {
        grouped
            .entry(row.try_get("root").map_err(db)?)
            .or_default()
            .push(row);
    }
    grouped
        .into_iter()
        .map(|(id, rows)| Ok((id, path_from_rows(&rows, org)?)))
        .collect()
}

fn path_from_rows(rows: &[PgRow], org: OrgId) -> Result<DepartmentPath, KernelError> {
    let mut path = Vec::new();
    let mut dissolved_root = None;
    let mut placement = None;
    for (i, row) in rows.iter().enumerate() {
        let id: Uuid = row.try_get("org_unit_id").map_err(db)?;
        let dissolved: Option<bool> = row.try_get("dissolved").map_err(db)?;
        if i == 0 && dissolved == Some(true) {
            // Keep the placement for employees without reviving this department's grants.
            dissolved_root = Some(NodeRef {
                kind: NodeKind::Department,
                id,
            });
        }
        let wp: Option<Uuid> = row.try_get("workplace_id").map_err(db)?;
        let le: Option<Uuid> = row.try_get("legal_entity_id").map_err(db)?;
        let represents: bool = row.try_get("represents").map_err(db)?;
        if !(represents && wp.is_some()) {
            path.push(NodeRef {
                kind: NodeKind::Department,
                id,
            });
        }
        if let (Some(wp), Some(le)) = (wp, le) {
            let resolved = scope_path(org, NodeKind::Workplace, Some(wp), Some(le));
            path.extend(resolved.0.iter().copied());
            placement = Some(resolved);
            break;
        }
    }
    Ok(DepartmentPath {
        current: dissolved_root.map_or(NodePath(path), |node| NodePath(vec![node])),
        placement,
    })
}
