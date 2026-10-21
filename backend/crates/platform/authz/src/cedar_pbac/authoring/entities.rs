use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use cedar_policy::{
    Context, Entities, Entity, EntityId, EntityTypeName, EntityUid, Request, RestrictedExpression,
    Schema,
};

use super::{PROPERTY_POLICY_ACTION, SimRequest};

pub(super) fn entity_uid(type_name: &str, id: &str) -> Result<EntityUid, String> {
    let parsed = EntityTypeName::from_str(type_name)
        .map_err(|err| format!("entity type {type_name:?} invalid: {err}"))?;
    Ok(EntityUid::from_type_name_and_id(parsed, EntityId::new(id)))
}

pub(super) fn build_entities(request: &SimRequest, schema: &Schema) -> Result<Entities, String> {
    let subject_uid = entity_uid("Subject", &request.subject.user_id)?;
    let subject_attrs = HashMap::from([
        (
            "org".to_owned(),
            RestrictedExpression::new_string(request.subject.org.to_string()),
        ),
        (
            "user_id".to_owned(),
            RestrictedExpression::new_string(request.subject.user_id.clone()),
        ),
        (
            "roles".to_owned(),
            RestrictedExpression::new_set(
                request
                    .subject
                    .roles
                    .iter()
                    .cloned()
                    .map(RestrictedExpression::new_string),
            ),
        ),
        (
            "clearance_keys".to_owned(),
            RestrictedExpression::new_set(
                request
                    .subject
                    .clearance_keys
                    .iter()
                    .cloned()
                    .map(RestrictedExpression::new_string),
            ),
        ),
    ]);
    let subject = Entity::new(subject_uid, subject_attrs, HashSet::new())
        .map_err(|err| format!("subject entity failed: {err}"))?;

    let resource_eid = request
        .resource
        .resource_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| request.resource.resource_type.clone());
    let resource_uid = entity_uid("Resource", &resource_eid)?;
    let mut resource_attrs = HashMap::from([
        (
            "org".to_owned(),
            RestrictedExpression::new_string(request.resource.org.to_string()),
        ),
        (
            "resource_type".to_owned(),
            RestrictedExpression::new_string(request.resource.resource_type.clone()),
        ),
    ]);
    if let Some(resource_id) = &request.resource.resource_id {
        resource_attrs.insert(
            "resource_id".to_owned(),
            RestrictedExpression::new_string(resource_id.clone()),
        );
    }
    if let Some(owner) = &request.resource.owner {
        resource_attrs.insert(
            "owner".to_owned(),
            RestrictedExpression::new_string(owner.clone()),
        );
    }
    if let Some(branch) = &request.resource.branch {
        resource_attrs.insert(
            "branch".to_owned(),
            RestrictedExpression::new_string(branch.clone()),
        );
    }
    if let Some(legal_hold) = request.resource.legal_hold {
        resource_attrs.insert(
            "legal_hold".to_owned(),
            RestrictedExpression::new_bool(legal_hold),
        );
    }
    let resource = Entity::new(resource_uid, resource_attrs, HashSet::new())
        .map_err(|err| format!("resource entity failed: {err}"))?;

    Entities::from_entities([subject, resource], Some(schema))
        .map_err(|err| format!("entities failed: {err}"))
}

pub(super) fn build_request(request: &SimRequest, schema: &Schema) -> Result<Request, String> {
    let subject_uid = entity_uid("Subject", &request.subject.user_id)?;
    let action_uid = entity_uid("Action", &request.action)?;
    let resource_eid = request
        .resource
        .resource_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| request.resource.resource_type.clone());
    let resource_uid = entity_uid("Resource", &resource_eid)?;

    let mut context_pairs: Vec<(String, RestrictedExpression)> = Vec::new();
    if request.action == PROPERTY_POLICY_ACTION {
        if let Some(field) = &request.field {
            context_pairs.push((
                "field".to_owned(),
                RestrictedExpression::new_string(field.clone()),
            ));
        }
    } else if let Some(purpose) = &request.purpose {
        context_pairs.push((
            "purpose".to_owned(),
            RestrictedExpression::new_string(purpose.clone()),
        ));
    }
    let context =
        Context::from_pairs(context_pairs).map_err(|err| format!("context failed: {err}"))?;

    Request::new(subject_uid, action_uid, resource_uid, context, Some(schema))
        .map_err(|err| format!("request failed: {err}"))
}
