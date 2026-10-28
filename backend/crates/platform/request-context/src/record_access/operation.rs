//! Saved operation output uses its immutable audit action and current ownership.
use console_kernel_core::{BranchId, BranchScope};
use console_platform_authz::access::load_access_subject;
use console_platform_authz::cedar_pbac::action_schema::compile_action_bundle;
use console_platform_authz::cedar_pbac::facts::scope::{granted_scope, scope_facts};
use console_platform_authz::cedar_pbac::facts::{Facts, evaluate_with_facts};
use console_platform_authz::{
    Action, AuthorizationRequest, AuthorizationResource, CedarEvaluation, Feature, Principal,
    authorize, authorize_org_wide,
};
use console_platform_db::{DbError, with_org_conn};
use serde_json::{Map, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::BTreeMap;
use uuid::Uuid;

fn feature(kind: &str, action: &str) -> Option<Feature> {
    match (kind, action) {
        ("logistics_asn", "logistics.asn.create" | "logistics.asn.receive") => {
            Some(Feature::LogisticsReceive)
        }
        ("logistics_asn", "logistics.asn.putaway") => Some(Feature::LogisticsPutaway),
        ("logistics_fulfillment", "logistics.fulfillment.release") => {
            Some(Feature::LogisticsRelease)
        }
        ("logistics_fulfillment", "logistics.fulfillment.pick" | "logistics.fulfillment.pack") => {
            Some(Feature::LogisticsPickPack)
        }
        ("logistics_shipment", "logistics.shipment.dispatch") => Some(Feature::LogisticsDispatch),
        ("logistics_shipment", "logistics.shipment.pod") => Some(Feature::LogisticsPod),
        ("logistics_shipment", "logistics.shipment.settle") => Some(Feature::LogisticsSettle),
        _ => None,
    }
}

pub(super) async fn may_read_saved(pool: &PgPool, p: &Principal, item: &Value) -> bool {
    let (Some(kind), Some(id), Some(audit)) = (
        item["type"].as_str(),
        item["id"].as_str(),
        item["audit_id"].as_str(),
    ) else {
        return false;
    };
    let (Ok(id), Ok(audit)) = (Uuid::parse_str(id), Uuid::parse_str(audit)) else {
        return false;
    };
    let sql = match kind {
        "logistics_asn" => "SELECT branch_id FROM logistics_asns WHERE org_id=$1 AND id=$2",
        "logistics_fulfillment" => {
            "SELECT branch_id FROM logistics_fulfillments WHERE org_id=$1 AND id=$2"
        }
        "logistics_shipment" => {
            "SELECT branch_id FROM logistics_shipments WHERE org_id=$1 AND id=$2"
        }
        _ => return false,
    };
    let (p, kind) = (p.clone(), kind.to_owned());
    with_org_conn::<_,_,DbError>(pool, p.org_id, move |tx| Box::pin(async move {
        let org = p.org_id.as_uuid();
        let Some(action) = sqlx::query_scalar::<_,String>("SELECT action FROM audit_events WHERE org_id=$1 AND id=$2 AND target_type=$3 AND target_id=$4 AND outcome='ALLOWED'")
            .bind(org).bind(audit).bind(&kind).bind(id.to_string()).fetch_optional(tx.as_mut()).await? else { return Ok(false); };
        let Some(feature) = feature(&kind, &action) else { return Ok(false); };
        let Some(branch) = sqlx::query_scalar::<_,Uuid>(sqlx::AssertSqlSafe(sql)).bind(org).bind(id).fetch_optional(tx.as_mut()).await? else { return Ok(false); };
        let readable = match p.branch_scope {
            BranchScope::All => authorize_org_wide(&p, Action::new(feature)),
            _ => authorize(&p, Action::new(feature), BranchId::from_uuid(branch)),
        }.is_ok();
        Ok(console_platform_authz::cedar_pbac::actions::command_outcome::decide(&p.user_id.to_string(), &p.org_id.to_string(), false, readable).unwrap_or(false))
    })).await.unwrap_or(false)
}

pub(super) fn subject(fields: &Map<String, Value>) -> Option<(&'static str, Uuid)> {
    let kind = if fields.contains_key("biz_kind") && fields.contains_key("scheduled") {
        "legal_entity"
    } else if fields.contains_key("legal_entity_id") && fields.contains_key("brn") {
        "business_registration"
    } else if fields.contains_key("legal_entity_id") && fields.contains_key("default_branch_id") {
        "workplace"
    } else {
        return None;
    };
    Some((
        kind,
        fields
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| Uuid::parse_str(id).ok())
            .unwrap_or(Uuid::nil()),
    ))
}

fn subjects(value: &Value, items: &mut BTreeMap<(&'static str, Uuid), bool>) {
    match value {
        Value::Array(values) => values.iter().for_each(|value| subjects(value, items)),
        Value::Object(fields) => {
            if let Some(key) = subject(fields) {
                items.insert(key, false);
            }
            fields.values().for_each(|value| subjects(value, items));
        }
        _ => {}
    }
}

async fn reach(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
) -> Result<Option<Vec<Uuid>>, DbError> {
    if p.is_tenant_ops || p.branch_scope == BranchScope::All {
        return Ok(None);
    }
    let subject = load_access_subject(
        tx,
        p.org_id,
        *p.user_id.as_uuid(),
        time::OffsetDateTime::now_utc(),
    )
    .await
    .map_err(|e| DbError::Sqlx(sqlx::Error::Protocol(e.to_string())))?;
    let Some(mut ids) = granted_scope(
        subject
            .grants
            .iter()
            .filter_map(|grant| grant.scope.node())
            .map(|node| (node.kind, node.id)),
    ) else {
        return Ok(None);
    };
    let branches: Vec<Uuid> = match &p.branch_scope {
        BranchScope::Branches(branches) => branches.iter().map(|b| *b.as_uuid()).collect(),
        BranchScope::All => Vec::new(),
    };
    ids.extend(sqlx::query_scalar::<_,Uuid>("SELECT id FROM workplaces WHERE org_id=$1 AND default_branch_id=ANY($2) AND voided_at IS NULL")
        .bind(p.org_id.as_uuid()).bind(branches).fetch_all(tx.as_mut()).await?);
    Ok(Some(ids))
}

pub(super) async fn mask_entities(pool: &PgPool, p: &Principal, result: &mut Value) {
    let mut items = BTreeMap::new();
    subjects(result, &mut items);
    if items.is_empty() {
        return;
    }
    let (p, keys) = (p.clone(), items.clone());
    let allowed = with_org_conn::<_,_,DbError>(pool, p.org_id, move |tx| Box::pin(async move {
        let granted = reach(tx, &p).await?;
        let freshness = p.authz_freshness;
        let feature = Feature::LegalEntityManage;
        let Ok(bundle) = compile_action_bundle(p.org_id, freshness.policy_version, feature) else { return Ok(keys); };
        let request = AuthorizationRequest::new(p.clone(), Action::new(feature), AuthorizationResource::org_wide(p.org_id, "legal_entity")).with_subject_freshness(freshness);
        let mut allowed = keys;
        for ((kind,id), personal) in &mut allowed {
            let sql = match *kind {
                "legal_entity" => "SELECT ARRAY[id] FROM legal_entities WHERE org_id=$1 AND id=$2",
                "business_registration" => "SELECT ARRAY[legal_entity_id] FROM business_registrations WHERE org_id=$1 AND id=$2",
                "workplace" => "SELECT ARRAY[legal_entity_id,id] FROM workplaces WHERE org_id=$1 AND id=$2",
                _ => continue,
            };
            if let Some(resource) = sqlx::query_scalar::<_,Vec<Uuid>>(sqlx::AssertSqlSafe(sql)).bind(p.org_id.as_uuid()).bind(*id).fetch_optional(tx.as_mut()).await? {
                let facts = scope_facts(Facts::new(), granted.as_deref(), &resource);
                *personal = matches!(evaluate_with_facts(&request, &bundle, &facts), CedarEvaluation::Allow {..});
            }
        }
        Ok(allowed)
    })).await.unwrap_or(items);
    super::mask_entity_fields(result, &allowed, None);
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::super::{access_tests::Fixture, all_readable, mask_saved_result};
    use super::*;
    use console_kernel_core::{AuditAction, AuditEvent, TraceContext};
    use console_platform_authz::{EffectiveFeatureGrant, PermissionLevel, Role};
    use console_platform_db::insert_audit_event;
    use console_platform_test_support::MIGRATOR;
    use serde_json::json;
    use std::collections::BTreeSet;

    async fn saved(f: &Fixture, action: &str, kind: &str, id: Uuid) -> Value {
        let event = AuditEvent::new(
            Some(f.actor),
            AuditAction::new(action).unwrap(),
            kind,
            id.to_string(),
            TraceContext::generate(),
            time::OffsetDateTime::now_utc(),
        )
        .with_org(f.org)
        .with_branch(f.branches[0]);
        let touched = json!([{"type":kind,"id":id,"audit_id":event.id,"branch_id":f.branches[1]}]);
        let mut tx = f.owner.begin().await.unwrap();
        insert_audit_event(&mut tx, &event).await.unwrap();
        tx.commit().await.unwrap();
        touched
    }

    #[sqlx::test(migrator = "MIGRATOR")]
    async fn saved_logistics_output_needs_its_own_durable_action_and_current_branch(pool: PgPool) {
        let f = Fixture::new(pool.clone()).await;
        let foreign = Fixture::new(pool).await;
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO logistics_asns (org_id,id,branch_id,warehouse_code,external_reference,sku,expected_quantity,created_by) VALUES ($1,$2,$3,'WH','REF','SKU',1,$4)")
            .bind(f.org.as_uuid()).bind(id).bind(f.branches[0].as_uuid()).bind(f.actor.as_uuid()).execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
        let scope = BranchScope::Branches(BTreeSet::from([f.branches[0]]));
        let mut p = f.principal(scope.clone());
        p.effective_feature_grants = vec![EffectiveFeatureGrant::new(
            Feature::LogisticsReceive,
            PermissionLevel::Allow,
            scope.clone(),
        )];
        let touched = saved(&f, "logistics.asn.receive", "logistics_asn", id).await;
        assert!(all_readable(&f.rt, &p, &touched).await);
        assert!(!all_readable(&f.rt, &foreign.principal(BranchScope::All), &touched).await);
        assert!(!all_readable(&f.rt, &f.principal(scope.clone()), &touched).await);
        let putaway = saved(&f, "logistics.asn.putaway", "logistics_asn", id).await;
        assert!(!all_readable(&f.rt, &p, &putaway).await);
        let mut forged = touched.clone();
        forged[0]["id"] = json!(Uuid::new_v4());
        assert!(!all_readable(&f.rt, &p, &forged).await);
        forged = touched.clone();
        forged[0]["audit_id"] = json!(Uuid::new_v4());
        assert!(!all_readable(&f.rt, &p, &forged).await);
        sqlx::query("UPDATE logistics_asns SET branch_id=$3 WHERE org_id=$1 AND id=$2")
            .bind(f.org.as_uuid())
            .bind(id)
            .bind(f.branches[1].as_uuid())
            .execute(&f.owner)
            .await
            .unwrap(); // rls-arming: ok owner fixture
        assert!(!all_readable(&f.rt, &p, &touched).await);
        for (kind, action, expected) in [
            (
                "logistics_asn",
                "logistics.asn.create",
                Feature::LogisticsReceive,
            ),
            (
                "logistics_fulfillment",
                "logistics.fulfillment.release",
                Feature::LogisticsRelease,
            ),
            (
                "logistics_fulfillment",
                "logistics.fulfillment.pick",
                Feature::LogisticsPickPack,
            ),
            (
                "logistics_fulfillment",
                "logistics.fulfillment.pack",
                Feature::LogisticsPickPack,
            ),
            (
                "logistics_shipment",
                "logistics.shipment.dispatch",
                Feature::LogisticsDispatch,
            ),
            (
                "logistics_shipment",
                "logistics.shipment.pod",
                Feature::LogisticsPod,
            ),
            (
                "logistics_shipment",
                "logistics.shipment.settle",
                Feature::LogisticsSettle,
            ),
        ] {
            assert_eq!(feature(kind, action), Some(expected));
        }
        assert_eq!(
            feature("logistics_asn", "logistics.shipment.dispatch"),
            None
        );
        assert_eq!(feature("command_outcome", "logistics.asn.receive"), None);
    }

    #[sqlx::test(migrator = "MIGRATOR")]
    async fn current_entity_manage_masks_saved_people_after_scope_revocation(pool: PgPool) {
        let f = Fixture::new(pool).await;
        let role = f.role().await;
        f.grant(role, f.reader, Some(f.entities[0])).await;
        let mut p = f.principal(BranchScope::Branches(BTreeSet::from([f.branches[0]])));
        p.roles = BTreeSet::from([Role::Executive]);
        let original = json!({"entity":{"id":f.entities[0],"biz_kind":"INDIVIDUAL","scheduled":[],"current":{"name":"Public","representatives":["Private"],"directors":[{"name":"Private"}]},"can_manage":true},"unrelated":{"email":"Public"}});
        let mut result = original.clone();
        mask_saved_result(&f.rt, &p, &mut result).await;
        assert_eq!(result, original);
        sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE org_id=$1 AND account_id=$3")
            .bind(f.org.as_uuid()).bind(f.actor.as_uuid()).bind(f.reader.as_uuid()).execute(&f.owner).await.unwrap(); // rls-arming: ok owner fixture
        mask_saved_result(&f.rt, &p, &mut result).await;
        assert_eq!(result["entity"]["current"]["representatives"], Value::Null);
        assert_eq!(result["entity"]["current"]["directors"], Value::Null);
        assert_eq!(result["entity"]["can_manage"], false);
        assert_eq!(result["entity"]["current"]["name"], "Public");
        assert_eq!(result["unrelated"]["email"], "Public");
    }
}
