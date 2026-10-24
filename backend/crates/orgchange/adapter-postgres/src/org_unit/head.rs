use crate::*;

/// The latest revision of one OrgUnit, as the org tree sees it. Units without
/// a recognised `kind` (the region/branch source bindings) are not tree nodes.
pub(crate) struct UnitHead {
    pub(crate) id: Uuid,
    pub(crate) kind: OrgUnitKind,
    pub(crate) name: String,
    pub(crate) parent_id: Option<Uuid>,
    pub(crate) dissolved: bool,
    pub(crate) attributes: Value,
    pub(crate) effective_from: Date,
    pub(crate) updated_at: OffsetDateTime,
}

/// Latest-revision head query, suffixed with a literal tail (stays a literal).
macro_rules! latest_revision_sql {
    ($tail:literal) => {
        concat!(
            "SELECT u.id, latest.attributes, latest.created_at \
             FROM org_units u \
             JOIN LATERAL ( \
                 SELECT attributes, created_at FROM org_unit_revisions r \
                 WHERE r.org_id = u.org_id AND r.org_unit_id = u.id \
                 ORDER BY r.version DESC LIMIT 1 \
             ) latest ON true ",
            $tail
        )
    };
}
pub(crate) use latest_revision_sql;

pub(crate) fn attr_text(attributes: &Value, key: &str) -> Option<String> {
    attributes
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(crate) fn attr_uuid(attributes: &Value, key: &str) -> Option<Uuid> {
    attr_text(attributes, key).and_then(|v| Uuid::parse_str(&v).ok())
}

pub(crate) fn attr_date(attributes: &Value, fallback: OffsetDateTime) -> Date {
    attr_text(attributes, "effective_from")
        .and_then(|raw| {
            Date::parse(&raw, &time::format_description::well_known::Iso8601::DATE).ok()
        })
        .unwrap_or_else(|| fallback.to_offset(offset!(+9)).date())
}

pub(crate) fn unit_head_from_row(row: &PgRow) -> Result<Option<UnitHead>, PgOrgChangeError> {
    let attributes: Value = row.try_get("attributes")?;
    let Some(kind) = attr_text(&attributes, "kind").and_then(|k| OrgUnitKind::from_attr(&k)) else {
        return Ok(None);
    };
    let updated_at: OffsetDateTime = row.try_get("created_at")?;
    Ok(Some(UnitHead {
        id: row.try_get("id")?,
        kind,
        name: attr_text(&attributes, "name").unwrap_or_default(),
        parent_id: attr_text(&attributes, "parent_id").and_then(|v| Uuid::parse_str(&v).ok()),
        dissolved: attr_text(&attributes, "status").as_deref() == Some("dissolved"),
        effective_from: attr_date(&attributes, updated_at),
        attributes,
        updated_at,
    }))
}

pub(crate) async fn load_unit_head(
    tx: Tx<'_, '_>,
    id: Uuid,
) -> Result<Option<UnitHead>, PgOrgChangeError> {
    let row = sqlx::query(latest_revision_sql!("WHERE u.id = $1"))
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?;
    match row {
        Some(row) => unit_head_from_row(&row),
        None => Ok(None),
    }
}

/// Members of one unit (headcount semantics: see [`scope_headcount`]).
pub(crate) async fn unit_members(tx: Tx<'_, '_>, id: Uuid) -> Result<i64, PgOrgChangeError> {
    // `org_unit` text is checked too: rows moved by the pre-binding reassign
    // path stored the unit UUID there.
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM employees WHERE entity_employed_on(entity_today(), hire_on, exit_on, employment_status) \
         AND (org_unit_id = $1 OR org_unit = $1::text)",
    )
    .bind(id)
    .fetch_one(tx.as_mut())
    .await?)
}

pub(crate) async fn active_unit_children(
    tx: Tx<'_, '_>,
    id: Uuid,
) -> Result<i64, PgOrgChangeError> {
    children_left(tx, id, &[]).await
}

/// Active children of `id` other than `moved` (units an earlier op of the
/// same change moves away, org-06).
pub(crate) async fn children_left(
    tx: Tx<'_, '_>,
    id: Uuid,
    moved: &[Uuid],
) -> Result<i64, PgOrgChangeError> {
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM org_units u \
         JOIN LATERAL ( \
             SELECT attributes FROM org_unit_revisions r \
             WHERE r.org_id = u.org_id AND r.org_unit_id = u.id \
             ORDER BY r.version DESC LIMIT 1 \
         ) latest ON true \
         WHERE latest.attributes->>'parent_id' = $1::text \
           AND COALESCE(latest.attributes->>'status', 'active') <> 'dissolved' \
           AND u.id <> ALL($2)",
    )
    .bind(id)
    .bind(moved)
    .fetch_one(tx.as_mut())
    .await?)
}

/// Members of `id` an earlier op of the same change does not move (`all`:
/// a reassign of every member; else only `people`).
pub(crate) async fn members_left(
    tx: Tx<'_, '_>,
    id: Uuid,
    (all, people): (bool, &[Uuid]),
) -> Result<i64, PgOrgChangeError> {
    if all {
        return Ok(0);
    }
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM employees WHERE entity_employed_on(entity_today(), hire_on, exit_on, employment_status) \
         AND (org_unit_id = $1 OR org_unit = $1::text) AND id <> ALL($2)",
    )
    .bind(id)
    .bind(people)
    .fetch_one(tx.as_mut())
    .await?)
}

/// Every OrgUnit a proposal names must be visible in the caller's tenant at
/// draft time. RLS hides foreign units, so a foreign id and a missing id are
/// both 404 (deny by omission). The Company root id is a valid SITE parent.
pub(crate) async fn require_org_unit_refs_visible(
    tx: Tx<'_, '_>,
    org: OrgId,
    proposal: &[OrgProposalOp],
) -> Result<(), PgOrgChangeError> {
    for op in proposal {
        let ids: Vec<Uuid> = match op {
            OrgProposalOp::CreateOrgUnit { parent_id, .. } => parent_id.iter().copied().collect(),
            OrgProposalOp::RenameOrgUnit { org_unit_id, .. }
            | OrgProposalOp::DissolveOrgUnit {
                org_unit_id,
                merged_into: None,
            } => vec![*org_unit_id],
            OrgProposalOp::DissolveOrgUnit {
                org_unit_id,
                merged_into: Some(successor),
            } => vec![*org_unit_id, *successor],
            OrgProposalOp::MoveOrgUnit {
                org_unit_id,
                parent_id,
            } => vec![*org_unit_id, *parent_id],
            _ => Vec::new(),
        };
        for id in ids {
            if id == *org.as_uuid() {
                continue;
            }
            if load_unit_head(tx, id).await?.is_none() {
                return Err(KernelError::not_found("org unit was not found").into());
            }
        }
    }
    Ok(())
}

/// Resolve a proposed parent: `None` / the Company root id → no stored parent.
pub(crate) async fn resolve_parent(
    tx: Tx<'_, '_>,
    org: OrgId,
    parent_id: Option<Uuid>,
) -> Result<Result<Option<UnitHead>, ()>, PgOrgChangeError> {
    match parent_id {
        None => Ok(Ok(None)),
        Some(id) if id == *org.as_uuid() => Ok(Ok(None)),
        Some(id) => match load_unit_head(tx, id).await? {
            Some(head) if !head.dissolved => Ok(Ok(Some(head))),
            _ => Ok(Err(())),
        },
    }
}

/// Would re-parenting `unit` under `parent` close a loop?
pub(crate) async fn creates_cycle(
    tx: Tx<'_, '_>,
    unit: Uuid,
    parent: Uuid,
) -> Result<bool, PgOrgChangeError> {
    let mut cursor = Some(parent);
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = cursor {
        if id == unit || !seen.insert(id) {
            return Ok(true);
        }
        cursor = load_unit_head(tx, id)
            .await?
            .and_then(|head| head.parent_id);
    }
    Ok(false)
}
