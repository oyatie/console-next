use crate::*;

/// Region/branch rows for a tenant, LEFT JOIN'd to `org_unit_source_bindings`.
/// Unbound legacy rows stay visible with `org_unit_id: None` (gap is observable).
/// Caller must already have armed `app.current_org` for `org_id`.
pub(crate) async fn load_org_unit_references_tx(
    tx: Tx<'_, '_>,
    org_id: OrgId,
) -> Result<Vec<OrgUnitReference>, PgOrgChangeError> {
    let org = *org_id.as_uuid();
    let rows = sqlx::query(
        "SELECT source_kind, source_id, org_unit_id, resolution FROM ( \
             SELECT 'region'::text AS source_kind, \
                    r.id::text AS source_id, \
                    b.org_unit_id AS org_unit_id, \
                    CASE WHEN b.org_unit_id IS NULL THEN 'UNBOUND' ELSE 'RESOLVED' END AS resolution \
             FROM regions r \
             LEFT JOIN org_unit_source_bindings b \
               ON b.org_id = r.org_id \
              AND b.source_kind = 'region' \
              AND b.source_id = r.id::text \
             WHERE r.org_id = $1 \
             UNION ALL \
             SELECT 'branch'::text, \
                    br.id::text, \
                    b.org_unit_id, \
                    CASE WHEN b.org_unit_id IS NULL THEN 'UNBOUND' ELSE 'RESOLVED' END \
             FROM branches br \
             LEFT JOIN org_unit_source_bindings b \
               ON b.org_id = br.org_id \
              AND b.source_kind = 'branch' \
              AND b.source_id = br.id::text \
             WHERE br.org_id = $1 \
         ) ref \
         ORDER BY source_kind, source_id",
    )
    .bind(org)
    .fetch_all(tx.as_mut())
    .await?;

    let mut refs = Vec::with_capacity(rows.len());
    for row in rows {
        let status: String = row.get("resolution");
        let resolution_status = match status.as_str() {
            "RESOLVED" => CanonicalResolutionStatus::Resolved,
            _ => CanonicalResolutionStatus::Unbound,
        };
        refs.push(OrgUnitReference {
            org_unit_id: row.get("org_unit_id"),
            source_kind: row.get("source_kind"),
            source_id: row.get("source_id"),
            resolution_status,
        });
    }
    Ok(refs)
}
