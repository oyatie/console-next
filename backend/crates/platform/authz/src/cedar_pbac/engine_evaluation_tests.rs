// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::panic)]

use super::*;
use crate::cedar_pbac::engine::compile_bundle_from_sources;
use console_kernel_core::OrgId;

#[test]
fn preparation_errors_and_panics_fail_closed_in_the_shared_wrapper() {
    let bundle = compile_bundle_from_sources(
        OrgId::one(),
        1,
        "ops-v1",
        include_str!("../../../../ops/rest/cedar/ops.cedarschema"),
        include_str!("../../../../ops/rest/cedar/ops.cedar"),
    )
    .unwrap();
    assert!(
        matches!(evaluate_safely(&bundle, || Err("invalid facts".to_owned())),
        CedarEvaluation::Error { reason } if reason == "invalid facts")
    );
    assert!(
        matches!(evaluate_safely(&bundle, || panic!("synthetic Cedar panic")),
        CedarEvaluation::Error { reason } if reason == "cedar evaluation panicked")
    );
}
