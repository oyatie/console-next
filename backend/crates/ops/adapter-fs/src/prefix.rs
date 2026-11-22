// SPDX-License-Identifier: LicenseRef-Proprietary
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SpoolPrefix {
    Obligations,
    Alerts,
    Silences,
    Incidents,
    Actions,
    Promotions,
    Feedback,
    Reviews,
    Breakglass,
}

impl SpoolPrefix {
    pub const ALL: [Self; 9] = [
        Self::Obligations,
        Self::Alerts,
        Self::Silences,
        Self::Incidents,
        Self::Actions,
        Self::Promotions,
        Self::Feedback,
        Self::Reviews,
        Self::Breakglass,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Obligations => "obligations",
            Self::Alerts => "alerts",
            Self::Silences => "silences",
            Self::Incidents => "incidents",
            Self::Actions => "actions",
            Self::Promotions => "promotions",
            Self::Feedback => "feedback",
            Self::Reviews => "reviews",
            Self::Breakglass => "breakglass",
        }
    }
}
