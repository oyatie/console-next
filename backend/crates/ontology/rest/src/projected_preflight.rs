// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{
    ActionError, CanonicalPort, DeserializeOwned, DispatchTarget, KernelError,
    decode_canonical_query,
};
use serde_json::Value;
use uuid::Uuid;

pub(super) fn canonical_preflight_error(
    preflight: &console_ontology_canonical_domain::Preflight,
) -> ActionError {
    let message = preflight.blockers().join("; ");
    match preflight.code() {
        Some(code) => ActionError::domain(KernelError::validation(message).with_code(code)),
        None => ActionError::Validation(message),
    }
}

pub(super) fn canonical_port_preflight<P>(
    target: DispatchTarget,
    target_id: Option<Uuid>,
    params: Value,
) -> Result<(), ActionError>
where
    P: CanonicalPort,
    P::Query: DeserializeOwned,
{
    let query = decode_canonical_query::<P>(target, target_id, params)?;
    let preflight = P::preflight(&query);
    if !preflight.is_ok() {
        return Err(canonical_preflight_error(&preflight));
    }
    Ok(())
}
