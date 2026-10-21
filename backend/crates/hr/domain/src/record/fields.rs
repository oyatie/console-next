//! The four section shapes and their rules. Dates travel as `YYYY-MM-DD`;
//! 학력 dates are month precision (the day is set to 1 on validate).

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use time::Date;

use super::guard::{looks_like_identifier_number, optional_text, required_text};
use super::{code_enum, iso_date};

code_enum!(EduLevel {
    HighSchool => "HIGH_SCHOOL",
    Associate => "ASSOCIATE",
    Bachelor => "BACHELOR",
    Master => "MASTER",
    Doctorate => "DOCTORATE",
    Other => "OTHER",
});
code_enum!(EduStatus {
    Graduated => "GRADUATED",
    Expected => "EXPECTED",
    Enrolled => "ENROLLED",
    OnLeave => "ON_LEAVE",
    Completed => "COMPLETED",
    Withdrawn => "WITHDRAWN",
});
code_enum!(QualKind {
    NationalTechnical => "NATIONAL_TECHNICAL",
    NationalProfessional => "NATIONAL_PROFESSIONAL",
    Private => "PRIVATE",
    DriverLicense => "DRIVER_LICENSE",
    Foreign => "FOREIGN",
    Other => "OTHER",
});
code_enum!(
    /// No 면제 사유 and no 전역 구분: both can disclose health (PIPA §23).
    MilStatus {
        Completed => "COMPLETED",
        Serving => "SERVING",
        NotCompleted => "NOT_COMPLETED",
        Exempt => "EXEMPT",
        NotApplicable => "NOT_APPLICABLE",
    }
);
code_enum!(MilBranch {
    Army => "ARMY",
    Navy => "NAVY",
    AirForce => "AIR_FORCE",
    MarineCorps => "MARINE_CORPS",
    SocialService => "SOCIAL_SERVICE",
    Alternative => "ALTERNATIVE",
    Other => "OTHER",
});
code_enum!(TrainStatus {
    Completed => "COMPLETED",
    InProgress => "IN_PROGRESS",
    NotCompleted => "NOT_COMPLETED",
});

/// 학력.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Education {
    pub school: String,
    pub level: EduLevel,
    #[serde(default)]
    pub major: Option<String>,
    pub status: EduStatus,
    #[serde(default, with = "iso_date::option")]
    pub entered_on: Option<Date>,
    #[serde(default, with = "iso_date::option")]
    pub ended_on: Option<Date>,
}

/// 자격·면허. `number` is never a 운전면허번호 (고유식별정보, 시행령 §19.3):
/// a DRIVER_LICENSE entry records its kind and class only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Qualification {
    pub name: String,
    pub kind: QualKind,
    #[serde(default)]
    pub grade: Option<String>,
    #[serde(default)]
    pub issuer: Option<String>,
    #[serde(default)]
    pub number: Option<String>,
    #[serde(default, with = "iso_date::option")]
    pub acquired_on: Option<Date>,
    #[serde(default, with = "iso_date::option")]
    pub expires_on: Option<Date>,
}

/// 병역 (근로기준법 시행규칙 별지 제16호 「병역 사항」).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Military {
    pub status: MilStatus,
    #[serde(default)]
    pub branch: Option<MilBranch>,
    #[serde(default)]
    pub rank: Option<String>,
    #[serde(default, with = "iso_date::option")]
    pub served_from: Option<Date>,
    #[serde(default, with = "iso_date::option")]
    pub served_to: Option<Date>,
}

/// 교육 이수.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Training {
    pub course: String,
    #[serde(default)]
    pub provider: Option<String>,
    pub status: TrainStatus,
    #[serde(with = "iso_date")]
    pub started_on: Date,
    #[serde(default, with = "iso_date::option")]
    pub ended_on: Option<Date>,
    #[serde(default)]
    pub hours: Option<i32>,
}

pub(crate) fn ordered(
    from: Option<Date>,
    to: Option<Date>,
    message: &'static str,
) -> Result<(), KernelError> {
    match (from, to) {
        (Some(from), Some(to)) if to < from => Err(KernelError::validation(message)),
        _ => Ok(()),
    }
}

fn month(date: Option<Date>) -> Option<Date> {
    date.and_then(|d| d.replace_day(1).ok())
}

impl Education {
    pub(crate) fn validate(self) -> Result<Self, KernelError> {
        let v = Self {
            school: required_text(self.school, 100, "school")?,
            major: optional_text(self.major, 100, "major")?,
            entered_on: month(self.entered_on),
            ended_on: month(self.ended_on),
            ..self
        };
        ordered(
            v.entered_on,
            v.ended_on,
            "ended_on must not be before entered_on",
        )?;
        Ok(v)
    }
}

impl Qualification {
    pub(crate) fn validate(self) -> Result<Self, KernelError> {
        let v = Self {
            name: required_text(self.name, 100, "name")?,
            grade: optional_text(self.grade, 50, "grade")?,
            issuer: optional_text(self.issuer, 100, "issuer")?,
            number: optional_text(self.number, 50, "number")?,
            ..self
        };
        if let Some(number) = &v.number
            && (v.kind == QualKind::DriverLicense || looks_like_identifier_number(number))
        {
            return Err(KernelError::validation(
                "number must not hold a driver licence or passport number; record the kind and class only",
            ));
        }
        ordered(
            v.acquired_on,
            v.expires_on,
            "expires_on must not be before acquired_on",
        )?;
        Ok(v)
    }
}

impl Military {
    pub(crate) fn validate(self) -> Result<Self, KernelError> {
        let v = Self {
            rank: optional_text(self.rank, 30, "rank")?,
            ..self
        };
        let served = matches!(v.status, MilStatus::Completed | MilStatus::Serving);
        let details = v.branch.is_some()
            || v.rank.is_some()
            || v.served_from.is_some()
            || v.served_to.is_some();
        if details && !served {
            return Err(KernelError::validation(
                "branch, rank and service dates apply only to COMPLETED or SERVING",
            ));
        }
        ordered(
            v.served_from,
            v.served_to,
            "served_to must not be before served_from",
        )?;
        Ok(v)
    }
}

impl Training {
    pub(crate) fn validate(self) -> Result<Self, KernelError> {
        let v = Self {
            course: required_text(self.course, 100, "course")?,
            provider: optional_text(self.provider, 100, "provider")?,
            ..self
        };
        if v.hours.is_some_and(|h| !(1..=9999).contains(&h)) {
            return Err(KernelError::validation("hours must be between 1 and 9999"));
        }
        ordered(
            Some(v.started_on),
            v.ended_on,
            "ended_on must not be before started_on",
        )?;
        Ok(v)
    }
}
