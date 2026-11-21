// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeSet;

use console_app::CONFIGURED_ROUTE_SURFACES;

use super::super::{OPENAPI_YAML, normalize_path_parameters, openapi_path_keys, route_calls};

const OPS_OPENAPI_YAML: &str = include_str!("../../../openapi/ops.yaml");

pub(super) const OPS_REST_SOURCES: &[(&str, &str)] = &[(
    "ops REST",
    include_str!("../../../crates/ops/rest/src/lib.rs"),
)];

#[test]
fn ops_routes_stay_absent_from_openapi_yaml_and_present_in_ops_yaml() {
    let openapi_paths = openapi_path_keys(OPENAPI_YAML);
    let ops_paths = openapi_path_keys(OPS_OPENAPI_YAML);
    let configured_paths: BTreeSet<String> = CONFIGURED_ROUTE_SURFACES
        .iter()
        .flat_map(|surface| surface.paths.iter())
        .map(|path| normalize_path_parameters(path))
        .collect();

    for &(name, source) in OPS_REST_SOURCES {
        for route in route_calls(source, &[]) {
            let path = route
                .path
                .unwrap_or_else(|| panic!("{name} has unresolved route {}", route.argument));
            let normalized = normalize_path_parameters(&path);
            assert!(
                !openapi_paths.contains(&normalized),
                "{name} route {path} must stay absent from openapi.yaml"
            );
            assert!(
                !configured_paths.contains(&normalized),
                "{name} route {path} must stay absent from CONFIGURED_ROUTE_SURFACES"
            );
            assert!(
                ops_paths.contains(&normalized),
                "{name} route {path} must be documented in ops.yaml"
            );
        }
    }
}
