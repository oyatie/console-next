// SPDX-License-Identifier: LicenseRef-Proprietary
//! One classification for workplace masking and access-record subjects.
use crate::WorkplaceState;

pub struct WorkplacePersonalField {
    pub name: &'static str,
    pub is_present: fn(&WorkplaceState) -> bool,
}

/// The restricted fields previously guarded individually by `personal` in workplace views.
pub const WORKPLACE_PERSONAL_FIELDS: &[WorkplacePersonalField] = &[
    WorkplacePersonalField {
        name: "representative_name",
        is_present: |state| state.representative_name.is_some(),
    },
    WorkplacePersonalField {
        name: "mobile",
        is_present: |state| state.mobile.is_some(),
    },
    WorkplacePersonalField {
        name: "email",
        is_present: |state| state.email.is_some(),
    },
];
