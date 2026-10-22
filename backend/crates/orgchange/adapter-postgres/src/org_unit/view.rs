use crate::*;

pub(crate) fn head_view(head: UnitHead, org: OrgId, headcount: i64) -> OrgUnitHeadView {
    OrgUnitHeadView {
        id: head.id,
        kind: head.kind.into(),
        name: head.name,
        // A SITE hangs off the Company root on the wire; stored parent is null.
        parent_id: head
            .parent_id
            .or_else(|| (head.kind == OrgUnitKind::Site).then_some(*org.as_uuid())),
        status: if head.dissolved {
            OrgUnitStatus::Dissolved
        } else {
            OrgUnitStatus::Active
        },
        effective_from: head.effective_from,
        headcount,
        updated_at: head.updated_at,
    }
}

/// The tenant root has its own display name, independent of its legal entities.
pub(crate) async fn company_root(
    tx: Tx<'_, '_>,
    org: OrgId,
) -> Result<Option<OrgUnitHeadView>, PgOrgChangeError> {
    let Some(row) =
        sqlx::query("SELECT name, created_at, updated_at FROM organizations WHERE id=$1")
            .bind(org.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?
    else {
        return Ok(None);
    };
    let name: String = row.try_get("name")?;
    let created_at: OffsetDateTime = row.try_get("created_at")?;
    let updated_at: OffsetDateTime = row.try_get("updated_at")?;
    let headcount: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employees WHERE employment_status <> 'EXITED'")
            .fetch_one(tx.as_mut())
            .await?;
    Ok(Some(OrgUnitHeadView {
        id: *org.as_uuid(),
        kind: OrgTreeNodeKind::Company,
        name,
        parent_id: None,
        status: OrgUnitStatus::Active,
        effective_from: created_at.to_offset(offset!(+9)).date(),
        headcount,
        updated_at,
    }))
}

pub(crate) async fn unit_headcounts(
    tx: Tx<'_, '_>,
) -> Result<BTreeMap<Uuid, i64>, PgOrgChangeError> {
    let rows: Vec<(Uuid, i64)> = sqlx::query_as(
        "SELECT org_unit_id, count(*) FROM employees \
         WHERE employment_status <> 'EXITED' AND org_unit_id IS NOT NULL \
         GROUP BY org_unit_id",
    )
    .fetch_all(tx.as_mut())
    .await?;
    Ok(rows.into_iter().collect())
}

/// Each unit's stored 순서 among its siblings: a 부서's `org_unit_positions`
/// row, a SITE's place in the 법인-then-사업장 order the chart shows.
pub(crate) async fn unit_positions(
    tx: Tx<'_, '_>,
) -> Result<BTreeMap<Uuid, i32>, PgOrgChangeError> {
    let rows: Vec<(Uuid, i32)> = sqlx::query_as(
        "SELECT org_unit_id, position FROM (\
           SELECT org_unit_id, position, 0 AS site FROM org_unit_positions \
           UNION ALL SELECT p.org_unit_id, (row_number() OVER (ORDER BY e.sort_order NULLS LAST, e.created_at, e.id, \
             w.sort_order NULLS LAST, w.created_at, w.id) - 1)::int, 1 \
           FROM org_unit_placements p JOIN workplaces w ON w.id = p.workplace_id \
           JOIN legal_entities e ON e.id = w.legal_entity_id \
           WHERE p.represents_workplace AND w.voided_at IS NULL AND e.voided_at IS NULL \
             AND p.valid_from <= (now() AT TIME ZONE 'Asia/Seoul')::date \
             AND (p.valid_to IS NULL OR p.valid_to > (now() AT TIME ZONE 'Asia/Seoul')::date)) o \
         ORDER BY site",
    )
    .fetch_all(tx.as_mut())
    .await?;
    // A SITE's rank is read last, so it wins over any stray 부서 row.
    Ok(rows.into_iter().collect())
}

/// `heads` in the chart's tree order (`tree_order`).
pub(crate) fn in_tree_order(
    heads: Vec<UnitHead>,
    positions: &BTreeMap<Uuid, i32>,
) -> Vec<UnitHead> {
    let order = {
        let entries: Vec<TreeEntry<'_>> = heads
            .iter()
            .map(|h| TreeEntry {
                id: h.id,
                parent: h.parent_id,
                position: positions.get(&h.id).copied(),
                name: &h.name,
            })
            .collect();
        tree_order(&entries)
    };
    let mut by_id: BTreeMap<Uuid, UnitHead> = heads.into_iter().map(|h| (h.id, h)).collect();
    order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect()
}
