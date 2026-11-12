use crate::{Feature, PermissionLevel};

/// A requested authorization operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Action {
    feature: Feature,
    required: PermissionLevel,
}

impl Action {
    /// Full/direct use of a feature (only cells marked allowed, "ganeung").
    #[must_use]
    pub const fn new(feature: Feature) -> Self {
        Self {
            feature,
            required: PermissionLevel::Allow,
        }
    }

    /// Limited feature use (cells marked limited, "jehan", or allowed, "ganeung").
    #[must_use]
    pub const fn limited(feature: Feature) -> Self {
        Self {
            feature,
            required: PermissionLevel::Limited,
        }
    }

    /// Request-only feature use (cells marked request-only, "yocheong ganeung",
    /// or allowed, "ganeung").
    #[must_use]
    pub const fn request(feature: Feature) -> Self {
        Self {
            feature,
            required: PermissionLevel::RequestOnly,
        }
    }

    #[must_use]
    pub const fn feature(self) -> Feature {
        self.feature
    }

    #[must_use]
    pub const fn required_permission(self) -> PermissionLevel {
        self.required
    }
}
