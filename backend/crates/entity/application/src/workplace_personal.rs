// SPDX-License-Identifier: LicenseRef-Proprietary
//! One classification for workplace masking and access-record subjects.
use crate::WorkplaceState;
pub use console_kernel_core::personal_data::{WORKPLACE_PERSONAL_FIELDS, WorkplacePersonalField};

pub fn workplace_personal_field_is_present(
    field: WorkplacePersonalField,
    state: &WorkplaceState,
) -> bool {
    match field {
        WorkplacePersonalField::RepresentativeName => state.representative_name.is_some(),
        WorkplacePersonalField::Mobile => state.mobile.is_some(),
        WorkplacePersonalField::Email => state.email.is_some(),
    }
}
