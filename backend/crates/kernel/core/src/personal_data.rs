// SPDX-License-Identifier: LicenseRef-Proprietary
//! Workplace field classification shared by record masking and access logging.

#[derive(Clone, Copy)]
pub enum WorkplacePersonalField {
    RepresentativeName,
    Mobile,
    Email,
}

impl WorkplacePersonalField {
    pub const fn name(self) -> &'static str {
        match self {
            Self::RepresentativeName => "representative_name",
            Self::Mobile => "mobile",
            Self::Email => "email",
        }
    }
}

pub const WORKPLACE_PERSONAL_FIELDS: &[WorkplacePersonalField] = &[
    WorkplacePersonalField::RepresentativeName,
    WorkplacePersonalField::Mobile,
    WorkplacePersonalField::Email,
];
