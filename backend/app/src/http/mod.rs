//! Cross-cutting HTTP concerns: request limits, errors, metrics, tracing, ops endpoints.

pub(crate) mod cache_control;
pub(crate) mod client_errors;
pub(crate) mod error;
pub(crate) mod metrics;
pub(crate) mod ops;
pub(crate) mod overload;
pub(crate) mod redact;
pub(crate) mod release_toggles;
pub(crate) mod status;
pub(crate) mod trace;

/// Global request-body cap. Modest by design: the JSON APIs here carry small
/// payloads, and large evidence uploads go straight to object storage via
/// presigned URLs rather than through this process. Bounds memory per request.
pub(crate) const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;
