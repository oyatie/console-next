// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum Kind {
    Customer,
    Approval,
    #[serde(untagged)]
    Reference(Reference),
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum Reference {
    Document,
    OntologyInstance,
    KpiDefinition,
    Evidence,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OptionsQuery {
    kind: Kind,
    q: Option<String>,
    engagement_id: Option<Uuid>,
    offset: Option<i64>,
}
#[derive(Serialize, sqlx::FromRow)]
pub(super) struct Choice {
    id: Uuid,
    label: String,
    #[serde(with = "time::serde::rfc3339::option")]
    recorded_at: Option<OffsetDateTime>,
}
#[derive(Serialize)]
pub(super) struct Choices {
    items: Vec<Choice>,
    next_offset: Option<i64>,
}

pub(super) async fn list_options(
    State(state): State<ConsultingRestState>,
    headers: HeaderMap,
    Query(params): Query<OptionsQuery>,
) -> Result<Json<Choices>, RestError> {
    let actor = principal(&state, &headers).await?;
    require(&actor, true)?;
    let offset = params.offset.unwrap_or(0);
    if !(0..=i64::MAX - 31).contains(&offset) {
        return Err(RestError::kernel(KernelError::validation(
            "invalid consulting option offset",
        )));
    }
    if matches!(params.kind, Kind::Customer) {
        super::require_customer_read(&actor)?;
    }
    if matches!(params.kind, Kind::Approval) && params.engagement_id.is_none() {
        return Err(RestError::kernel(KernelError::validation(
            "approval choices require an engagement",
        )));
    }
    let org = actor.org_id;
    let text = params.q.unwrap_or_default();
    let mut items = with_org_conn(&state.pool, org, |tx| {
        Box::pin(async move {
            let rows = match params.kind {
                Kind::Customer => sqlx::query_as::<_, Choice>(
                    "SELECT id, name AS label, NULL::timestamptz AS recorded_at
                     FROM registry_customers WHERE org_id=$1 AND name ILIKE '%' || $2 || '%'
                     ORDER BY name, id LIMIT 31 OFFSET $3",
                ).bind(org.as_uuid()).bind(text.trim()).bind(offset).fetch_all(tx.as_mut()).await?,
                Kind::Approval => sqlx::query_as::<_, Choice>(
                    "SELECT a.id, a.request_ref::text AS label, a.decided_at AS recorded_at
                     FROM gov_approvals a
                     WHERE a.org_id=$1 AND a.target_ref=$2 AND a.kind='consulting.engagement.approval'
                       AND a.decision='approved' AND a.requested_by<>$3
                       AND NOT EXISTS (SELECT 1 FROM gov_approval_consumptions c WHERE c.org_id=a.org_id AND c.approval_id=a.id)
                       AND a.request_ref::text ILIKE '%' || $4 || '%'
                     ORDER BY a.decided_at DESC, a.id LIMIT 31 OFFSET $5",
                ).bind(org.as_uuid()).bind(params.engagement_id).bind(actor.user_id.as_uuid())
                    .bind(text.trim()).bind(offset).fetch_all(tx.as_mut()).await?,
                Kind::Reference(kind) => {
                    let source = match kind {
                        Reference::Document => "DOCUMENT",
                        Reference::OntologyInstance => "ONTOLOGY_INSTANCE",
                        Reference::KpiDefinition => "KPI_DEFINITION",
                        Reference::Evidence => "EVIDENCE",
                    };
                    sqlx::query_as::<_, Choice>(
                        "SELECT id, source_version || ' · ' || source_id::text AS label, evaluated_at AS recorded_at
                         FROM consulting_reference_bindings
                         WHERE org_id=$1 AND source_kind=$2 AND (source_version ILIKE '%' || $3 || '%' OR source_id::text ILIKE '%' || $3 || '%')
                         ORDER BY evaluated_at DESC, id LIMIT 31 OFFSET $4",
                    ).bind(org.as_uuid()).bind(source).bind(text.trim()).bind(offset).fetch_all(tx.as_mut()).await?
                }
            };
            Ok::<_, DbError>(rows)
        })
    }).await.map_err(RestError::db)?;
    let next_offset = (items.len() > 30).then_some(offset + 30);
    items.truncate(30);
    Ok(Json(Choices { items, next_offset }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_platform_authz::{EffectiveFeatureGrant, PermissionLevel, Role};
    #[test]
    fn consulting_management_alone_does_not_grant_customer_directory_reads() {
        let actor = Principal::new(
            UserId::new(),
            OrgId::one(),
            [Role::Member].into_iter().collect(),
            BranchScope::All,
        );
        let manager = actor.with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::ConsultingManage,
            PermissionLevel::Allow,
            BranchScope::All,
        )]);
        assert!(require(&manager, true).is_ok());
        assert!(require_customer_read(&manager).is_err());
    }
}
