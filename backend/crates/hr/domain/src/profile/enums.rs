//! The EMP-MODEL closed value sets (parity E4, E5, E13). Each value is the
//! wire code and the database code; labels live in the client catalogs.

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};

/// A closed set of SCREAMING_SNAKE codes with `ALL`, `as_str` and `parse`.
macro_rules! code_enum {
    ($(#[$doc:meta])* $name:ident, $field:literal { $($variant:ident = $code:literal),+ $(,)? }) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $code)] $variant),+
        }

        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $code),+ }
            }

            /// # Errors
            /// Validation naming the field when `value` is not one of the codes.
            pub fn parse(value: &str) -> Result<Self, KernelError> {
                Self::ALL
                    .iter()
                    .copied()
                    .find(|candidate| candidate.as_str() == value.trim())
                    .ok_or_else(|| KernelError::validation(concat!($field, " is not a known value")))
            }
        }
    };
}

code_enum!(
    /// 고용형태 (E13): one enum. The first four are the 0172 values.
    EmploymentType, "employment_type" {
        Regular = "REGULAR",
        Contract = "CONTRACT",
        PartTime = "PART_TIME",
        Intern = "INTERN",
        Daily = "DAILY",
        Executive = "EXECUTIVE",
        DispatchedIn = "DISPATCHED_IN",
        OutsourcedOnSite = "OUTSOURCED_ON_SITE",
        Freelance = "FREELANCE",
    }
);

code_enum!(
    /// 근로자 구분 (E13), derived from [`EmploymentType`] and never stored.
    /// Values match the HR-registers `WorkerRelation` (hr-reports-registers §2.3).
    WorkerClassification, "worker_classification" {
        Employee = "EMPLOYEE",
        Executive = "EXECUTIVE",
        DispatchedIn = "DISPATCHED_IN",
        OutsourcedOnSite = "OUTSOURCED_ON_SITE",
        PlatformOrFreelance = "PLATFORM_OR_FREELANCE",
    }
);

code_enum!(
    /// 임금 단위 (E5).
    PayUnit, "pay_unit" {
        Monthly = "MONTHLY",
        Hourly = "HOURLY",
        Daily = "DAILY",
        Annual = "ANNUAL",
    }
);

code_enum!(
    /// 신분증명 종류 (E4, BW-19). Only the type is kept: decisions #6.
    IdType, "id_type" {
        Rrn = "RRN",
        Arc = "ARC",
        DomesticResidence = "DOMESTIC_RESIDENCE",
        NotIssued = "NOT_ISSUED",
    }
);

impl EmploymentType {
    /// 근로자 구분. A 임원 is not presumed a 근로자: 근로자성 is a judgement
    /// recorded later (`LsaWorkerStatus`, hr-reports-registers P-2). 파견 받은
    /// 인력, 도급 인력 and 프리랜서 are not the tenant's 근로자 at all.
    #[must_use]
    pub const fn worker_classification(self) -> WorkerClassification {
        match self {
            Self::Regular | Self::Contract | Self::PartTime | Self::Intern | Self::Daily => {
                WorkerClassification::Employee
            }
            Self::Executive => WorkerClassification::Executive,
            Self::DispatchedIn => WorkerClassification::DispatchedIn,
            Self::OutsourcedOnSite => WorkerClassification::OutsourcedOnSite,
            Self::Freelance => WorkerClassification::PlatformOrFreelance,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_round_trips_and_unknown_is_refused() {
        for value in EmploymentType::ALL {
            assert_eq!(EmploymentType::parse(value.as_str()).unwrap(), *value);
        }
        for value in PayUnit::ALL {
            assert_eq!(PayUnit::parse(value.as_str()).unwrap(), *value);
        }
        for value in IdType::ALL {
            assert_eq!(IdType::parse(value.as_str()).unwrap(), *value);
        }
        assert!(EmploymentType::parse("정규").is_err());
        assert!(IdType::parse("").is_err());
    }

    #[test]
    fn only_the_five_worker_forms_classify_as_employee() {
        let employees: Vec<_> = EmploymentType::ALL
            .iter()
            .filter(|kind| kind.worker_classification() == WorkerClassification::Employee)
            .map(|kind| kind.as_str())
            .collect();
        assert_eq!(
            employees,
            ["REGULAR", "CONTRACT", "PART_TIME", "INTERN", "DAILY"]
        );
        assert_eq!(
            EmploymentType::Freelance.worker_classification(),
            WorkerClassification::PlatformOrFreelance
        );
    }
}
