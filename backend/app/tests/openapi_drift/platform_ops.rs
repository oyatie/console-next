// SPDX-License-Identifier: LicenseRef-Proprietary
use super::super::{
    PLATFORM_ROUTE_OPERATIONS, PlatformRouteOperation, SUPPORT_REFERENCE_ROUTE_OPERATIONS,
};

// Identity mounts the operator profile outside the platform REST crate.
const IDENTITY_PLATFORM_ROUTE_OPERATIONS: &[PlatformRouteOperation] = &[
    PlatformRouteOperation {
        method: "GET",
        path: console_identity_rest::PLATFORM_ME_PATH,
    },
    PlatformRouteOperation {
        method: "PATCH",
        path: console_identity_rest::PLATFORM_ME_PATH,
    },
];

pub fn platform_route_operations() -> impl Iterator<Item = &'static PlatformRouteOperation> {
    PLATFORM_ROUTE_OPERATIONS
        .iter()
        .chain(SUPPORT_REFERENCE_ROUTE_OPERATIONS)
        .chain(IDENTITY_PLATFORM_ROUTE_OPERATIONS)
}
