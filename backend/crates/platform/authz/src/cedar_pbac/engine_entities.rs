// SPDX-License-Identifier: LicenseRef-Proprietary
use std::panic::AssertUnwindSafe;

use cedar_policy::{Authorizer, Context, Decision, Entities, EntityUid, Request};

use super::CompiledBundle;
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
    match std::panic::catch_unwind(AssertUnwindSafe(|| {
        crate::cedar_stack::with_cedar_stack(|| {
            let principal = principal.parse::<EntityUid>().map_err(|e| e.to_string())?;
            let action = action.parse::<EntityUid>().map_err(|e| e.to_string())?;
            let resource = resource.parse::<EntityUid>().map_err(|e| e.to_string())?;
            let context = Context::from_json_value(context, Some((&bundle.schema, &action)))
                .map_err(|e| e.to_string())?;
            let entities = Entities::from_json_value(entities, Some(&bundle.schema))
                .map_err(|e| e.to_string())?;
            let request = Request::new(principal, action, resource, context, Some(&bundle.schema))
                .map_err(|e| e.to_string())?;
            let response = Authorizer::new().is_authorized(&request, &bundle.policies, &entities);
            let errors: Vec<_> = response
                .diagnostics()
                .errors()
                .map(ToString::to_string)
                .collect();
            // An erroring forbid is skipped by Cedar; its permit must not win.
            if !errors.is_empty() {
                return Err(format!("cedar evaluation errors: {}", errors.join("; ")));
            }
            Ok(match response.decision() {
                Decision::Allow => CedarEvaluation::Allow {
                    bundle_key: bundle.key.clone(),
                },
                Decision::Deny => CedarEvaluation::Deny {
                    bundle_key: bundle.key.clone(),
                    reason: "cedar denied: no matching permit".to_owned(),
                },
            })
        })
    })) {
        Ok(Ok(evaluation)) => evaluation,
        Ok(Err(reason)) => CedarEvaluation::Error { reason },
        Err(_) => CedarEvaluation::Error {
            reason: "cedar evaluation panicked".to_owned(),
        },
    }
}
