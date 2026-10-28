// SPDX-License-Identifier: LicenseRef-Proprietary
use std::panic::AssertUnwindSafe;

use cedar_policy::{Authorizer, Decision, Entities, Request};

use super::CompiledBundle;
use crate::CedarEvaluation;

pub(in crate::cedar_pbac) fn evaluate_safely(
    bundle: &CompiledBundle,
    prepare: impl FnOnce() -> Result<(Request, Entities), String>,
) -> CedarEvaluation {
    match std::panic::catch_unwind(AssertUnwindSafe(|| {
        crate::cedar_stack::with_cedar_stack(|| {
            let (request, entities) = prepare()?;
            let response = Authorizer::new().is_authorized(&request, &bundle.policies, &entities);
            // Cedar skips an erroring forbid; its permit must never win.
            let errors: Vec<_> = response
                .diagnostics()
                .errors()
                .map(ToString::to_string)
                .collect();
            if !errors.is_empty() {
                return Err(format!("cedar evaluation errors: {}", errors.join("; ")));
            }
            Ok(match response.decision() {
                Decision::Allow => CedarEvaluation::Allow {
                    bundle_key: bundle.key.clone(),
                },
                Decision::Deny => CedarEvaluation::Deny {
                    bundle_key: bundle.key.clone(),
                    reason: crate::cedar_pbac::enforce::denial_reason(&bundle.policies, &response),
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

#[cfg(test)]
#[path = "engine_evaluation_tests.rs"]
mod tests;
