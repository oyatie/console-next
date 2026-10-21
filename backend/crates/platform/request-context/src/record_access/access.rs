//! Grant outcomes use the grant list's current Access × View authority.
use console_kernel_core::OrgId;
use console_platform_authz::Principal;
use console_platform_authz::access::{
    AccessSlice, Domain, Level, NodeKind, NodePath, action_group, load_access_subject, scope_path,
};
use console_platform_db::DbError;
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub(super) async fn may_read(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    kind: &str,
    id: Uuid,
) -> Result<bool, DbError> {
    let subject = load_access_subject(
        tx,
        p.org_id,
        *p.user_id.as_uuid(),
        time::OffsetDateTime::now_utc(),
    )
    .await
    .map_err(|e| DbError::Sqlx(sqlx::Error::Protocol(e.to_string())))?;
    let Ok(slice) = AccessSlice::compile(&subject) else {
        return Ok(false);
    };
    let view = action_group(Domain::Access, Level::View);
    if matches!(kind, "access_role" | "access_roles") {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM access_roles WHERE org_id=$1 AND id=$2)",
        )
        .bind(p.org_id.as_uuid())
        .bind(id)
        .fetch_one(tx.as_mut())
        .await?;
        return Ok(exists
            && (subject.is_ops
                || subject.grants.iter().any(|grant| {
                    grant.lines.iter().any(|line| {
                        line.domain == Domain::Access && line.levels.contains(&Level::View)
                    }) && slice.allows(&view, &grant.scope).unwrap_or(false)
                })));
    }
    if kind == "access_grant" {
        return Ok(grant_scope(tx, p.org_id, id)
            .await?
            .is_some_and(|path| slice.allows(&view, &path).unwrap_or(false)));
    }
    let request: Option<Value> =
        sqlx::query_scalar("SELECT request FROM access_grant_receipts WHERE org_id=$1 AND id=$2")
            .bind(p.org_id.as_uuid())
            .bind(id)
            .fetch_optional(tx.as_mut())
            .await?;
    let Some(ops) = request
        .as_ref()
        .and_then(|r| r.get("ops"))
        .and_then(Value::as_array)
        .filter(|ops| !ops.is_empty())
    else {
        return Ok(false);
    };
    // The receipt is readable only when every concrete grant scope is readable.
    for op in ops {
        let path = match op.get("op").and_then(Value::as_str) {
            Some("grant") => {
                let Some(scope) = op.get("scope") else {
                    return Ok(false);
                };
                if scope.get("include_descendants").and_then(Value::as_bool) != Some(true) {
                    return Ok(false);
                }
                let Some(kind) = scope
                    .get("kind")
                    .and_then(Value::as_str)
                    .and_then(NodeKind::parse)
                else {
                    return Ok(false);
                };
                let node = match scope.get("node_id") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(id)) => match Uuid::parse_str(id) {
                        Ok(id) => Some(id),
                        Err(_) => return Ok(false),
                    },
                    _ => return Ok(false),
                };
                node_scope(tx, p.org_id, kind, node).await?
            }
            Some("revoke" | "set_end") => {
                let Some(id) = op
                    .get("grant_id")
                    .and_then(Value::as_str)
                    .and_then(|id| Uuid::parse_str(id).ok())
                else {
                    return Ok(false);
                };
                grant_scope(tx, p.org_id, id).await?
            }
            _ => return Ok(false),
        };
        let Some(path) = path else { return Ok(false) };
        if !slice.allows(&view, &path).unwrap_or(false) {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn grant_scope(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    id: Uuid,
) -> Result<Option<NodePath>, DbError> {
    let row = sqlx::query("SELECT scope_kind,COALESCE(legal_entity_id,workplace_id,org_unit_id) AS node_id FROM access_grants WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid()).bind(id).fetch_optional(tx.as_mut()).await?;
    let Some(row) = row else { return Ok(None) };
    let raw: String = row.try_get("scope_kind")?;
    let Some(kind) = NodeKind::parse(&raw) else {
        return Ok(None);
    };
    node_scope(tx, org, kind, row.try_get("node_id")?).await
}

// Matches access::actor::node_path; missing or unsupported nodes stay closed.
async fn node_scope(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    kind: NodeKind,
    node: Option<Uuid>,
) -> Result<Option<NodePath>, DbError> {
    let entity = match (kind, node) {
        (NodeKind::Tenant, None) => return Ok(Some(NodePath::tenant(org))),
        (NodeKind::LegalEntity, Some(id)) => sqlx::query_scalar(
            "SELECT id FROM legal_entities WHERE org_id=$1 AND id=$2 AND voided_at IS NULL",
        ).bind(org.as_uuid()).bind(id).fetch_optional(tx.as_mut()).await?,
        (NodeKind::Workplace, Some(id)) => sqlx::query_scalar(
            "SELECT legal_entity_id FROM workplaces WHERE org_id=$1 AND id=$2 AND voided_at IS NULL",
        ).bind(org.as_uuid()).bind(id).fetch_optional(tx.as_mut()).await?,
        _ => return Ok(None),
    };
    Ok(entity.map(|entity| scope_path(org, kind, node, Some(entity))))
}
