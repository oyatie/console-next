// SPDX-License-Identifier: LicenseRef-Proprietary
use cedar_policy::{Context, Entities, EntityUid, Request};

use super::{CompiledBundle, evaluate_safely};
use crate::CedarEvaluation;

/// Evaluate server-loaded entities without a tenant-shaped principal.
/// UIDs use Cedar syntax; entities and context use Cedar JSON. Never pass
/// client-supplied facts here. Schema, evaluation errors and panics fail closed.
#[must_use]
pub fn evaluate_entities(
    bundle: &CompiledBundle,
    principal: &str,
    action: &str,
    resource: &str,
    entities: serde_json::Value,
    context: serde_json::Value,
) -> CedarEvaluation {
    evaluate_safely(bundle, || {
        let principal = principal.parse::<EntityUid>().map_err(|e| e.to_string())?;
        let action = action.parse::<EntityUid>().map_err(|e| e.to_string())?;
        let resource = resource.parse::<EntityUid>().map_err(|e| e.to_string())?;
        let context = Context::from_json_value(context, Some((&bundle.schema, &action)))
            .map_err(|e| e.to_string())?;
        let entities =
            Entities::from_json_value(entities, Some(&bundle.schema)).map_err(|e| e.to_string())?;
        let request = Request::new(principal, action, resource, context, Some(&bundle.schema))
            .map_err(|e| e.to_string())?;
        Ok((request, entities))
    })
}
