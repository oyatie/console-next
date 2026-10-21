//! Row → typed section values for every revision read (0261 + 0262 columns).

use console_hr_domain::record::{
    Award, Basis, BasisStatute, Disability, DisabilitySeverity, Discipline, EduLevel, EduStatus,
    Education, Family, FamilyRelation, Language, MilBranch, MilStatus, Military, QualKind,
    Qualification, RecordFields, Section, TrainStatus, Training, Veteran, VeteranTarget,
};
use sqlx::Row;
use sqlx::postgres::PgRow;

use crate::HrError;

pub(super) fn code<T>(
    row: &PgRow,
    col: &str,
    parse: fn(&str) -> Result<T, console_kernel_core::KernelError>,
) -> Result<T, HrError> {
    let raw: String = row.try_get(col)?;
    Ok(parse(&raw)?)
}

fn opt_code<T>(
    row: &PgRow,
    col: &str,
    parse: fn(&str) -> Result<T, console_kernel_core::KernelError>,
) -> Result<Option<T>, HrError> {
    let raw: Option<String> = row.try_get(col)?;
    Ok(raw.as_deref().map(parse).transpose()?)
}

pub(super) fn fields_of(section: Section, row: &PgRow) -> Result<RecordFields, HrError> {
    Ok(match section {
        Section::Education => RecordFields::Education(Education {
            school: row.try_get("edu_school")?,
            level: code(row, "edu_level", EduLevel::parse)?,
            major: row.try_get("edu_major")?,
            status: code(row, "edu_status", EduStatus::parse)?,
            entered_on: row.try_get("edu_entered_on")?,
            ended_on: row.try_get("edu_ended_on")?,
        }),
        Section::Qualification => RecordFields::Qualification(Qualification {
            name: row.try_get("qual_name")?,
            kind: code(row, "qual_kind", QualKind::parse)?,
            grade: row.try_get("qual_grade")?,
            issuer: row.try_get("qual_issuer")?,
            number: row.try_get("qual_number")?,
            acquired_on: row.try_get("qual_acquired_on")?,
            expires_on: row.try_get("qual_expires_on")?,
        }),
        Section::Military => RecordFields::Military(Military {
            status: code(row, "mil_status", MilStatus::parse)?,
            branch: opt_code(row, "mil_branch", MilBranch::parse)?,
            rank: row.try_get("mil_rank")?,
            served_from: row.try_get("mil_served_from")?,
            served_to: row.try_get("mil_served_to")?,
        }),
        Section::Training => RecordFields::Training(Training {
            course: row.try_get("trn_course")?,
            provider: row.try_get("trn_provider")?,
            status: code(row, "trn_status", TrainStatus::parse)?,
            started_on: row.try_get("trn_started_on")?,
            ended_on: row.try_get("trn_ended_on")?,
            hours: row.try_get("trn_hours")?,
        }),
        Section::Language => RecordFields::Language(Language {
            language: row.try_get("lang_language")?,
            test: row.try_get("lang_test")?,
            score: row.try_get("lang_score")?,
            taken_on: row.try_get("lang_taken_on")?,
            expires_on: row.try_get("lang_expires_on")?,
        }),
        Section::Award => RecordFields::Award(Award {
            title: row.try_get("rnd_title")?,
            decided_on: row.try_get("rnd_decided_on")?,
            issuer: row.try_get("rnd_issuer")?,
            details: row.try_get("rnd_details")?,
        }),
        Section::Discipline => RecordFields::Discipline(Discipline {
            title: row.try_get("rnd_title")?,
            decided_on: row.try_get("rnd_decided_on")?,
            issuer: row.try_get("rnd_issuer")?,
            details: row.try_get("rnd_details")?,
            ends_on: row.try_get("rnd_ends_on")?,
        }),
        Section::Family => RecordFields::Family(Family {
            relation: code(row, "fam_relation", FamilyRelation::parse)?,
            name: row.try_get("fam_name")?,
            birth_date: row.try_get("fam_birth_date")?,
            cohabiting: row.try_get("fam_cohabiting")?,
        }),
        Section::Disability => RecordFields::Disability(Disability {
            severity: code(row, "dis_severity", DisabilitySeverity::parse)?,
            recognised_on: row.try_get("dis_recognised_on")?,
            basis: basis_of(row)?,
        }),
        Section::Veteran => RecordFields::Veteran(Veteran {
            target: code(row, "vet_target", VeteranTarget::parse)?,
            recognised_on: row.try_get("vet_recognised_on")?,
            basis: basis_of(row)?,
        }),
    })
}

fn basis_of(row: &PgRow) -> Result<Basis, HrError> {
    let kind: Option<String> = row.try_get("basis")?;
    Ok(match kind.as_deref() {
        Some("CONSENT") => Basis::Consent {
            consent_on: row.try_get("basis_consent_on")?,
        },
        Some("STATUTE") => Basis::Statute {
            statute: code(row, "basis_statute", BasisStatute::parse)?,
        },
        _ => {
            return Err(HrError::internal(
                "a restricted revision has no stored basis",
            ));
        }
    })
}
