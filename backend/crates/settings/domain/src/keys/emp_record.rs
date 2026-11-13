//! EMP-RECORD (MR-31, MR-33, MR-35) keys: one switch per HR record card section.
//! Append-only; see `keys/mod.rs`. On by default (decisions #21: the HR record card
//! is complete), except disability and veterans' status, which start off (PIPA §23①, below);
//! a tenant that has no purpose for a section turns it off, and from then on
//! nobody can record it (Personal Information Protection Act §16① minimum collection). Turning a
//! section back on collects more, so it is the loosening direction.

use console_kernel_core::OfficialSource;
use time::macros::date;

/// Personal Information Protection Act §16① (minimum collection of personal information),
/// MST 283839, in force
/// 2026-09-11; read on law.go.kr DRF 2026-10-06 (mvp-absolute-requirements).
pub const PIPA_16_1: OfficialSource = OfficialSource {
    authority: "National Assembly of Korea",
    title: "개인정보 보호법 제16조제1항",
    url: "https://www.law.go.kr/법령/개인정보보호법/제16조",
    retrieved_on: date!(2026 - 10 - 06),
};

/// Personal Information Protection Act §23① (restriction on processing sensitive information),
/// promulgation No. 21445, in force 2026-09-11; read on law.go.kr DRF 2026-10-06. Disability
/// is health information, so the disability · veterans sections start off: a tenant switches
/// one on only once it has
/// a §23①1 separate consent or a §23①2 statutory basis for it (MR-35).
pub const PIPA_23_1: OfficialSource = OfficialSource {
    authority: "National Assembly of Korea",
    title: "개인정보 보호법 제23조제1항",
    url: "https://www.law.go.kr/법령/개인정보보호법/제23조",
    retrieved_on: date!(2026 - 10 - 06),
};

macro_rules! emp_record { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    HrRecordEducationEnabled => "hr.record.education.enabled" = D::bool(true, Higher).cited(emp_record::PIPA_16_1);
    HrRecordQualificationEnabled => "hr.record.qualification.enabled" = D::bool(true, Higher).cited(emp_record::PIPA_16_1);
    HrRecordMilitaryEnabled => "hr.record.military.enabled" = D::bool(true, Higher).cited(emp_record::PIPA_16_1);
    HrRecordTrainingEnabled => "hr.record.training.enabled" = D::bool(true, Higher).cited(emp_record::PIPA_16_1);
    HrRecordLanguageEnabled => "hr.record.language.enabled" = D::bool(true, Higher).cited(emp_record::PIPA_16_1);
    HrRecordAwardEnabled => "hr.record.award.enabled" = D::bool(true, Higher).cited(emp_record::PIPA_16_1);
    HrRecordDisciplineEnabled => "hr.record.discipline.enabled" = D::bool(true, Higher).cited(emp_record::PIPA_16_1);
    HrRecordFamilyEnabled => "hr.record.family.enabled" = D::bool(true, Higher).cited(emp_record::PIPA_16_1);
    HrRecordDisabilityEnabled => "hr.record.disability.enabled" = D::bool(false, Higher).cited(emp_record::PIPA_23_1);
    HrRecordVeteranEnabled => "hr.record.veteran.enabled" = D::bool(false, Higher).cited(emp_record::PIPA_23_1);
] $($rest)* } }; }
