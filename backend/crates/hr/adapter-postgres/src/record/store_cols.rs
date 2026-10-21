//! The typed value columns of one revision (0261 + 0262): the entry's
//! section group is set, every other group stays NULL.

use console_hr_domain::record::{Basis, MilBranch, RecordFields};
use time::Date;

/// The typed value columns of one revision; the other sections stay NULL.
#[derive(Default)]
pub(super) struct Cols {
    pub edu_school: Option<String>,
    pub edu_level: Option<&'static str>,
    pub edu_major: Option<String>,
    pub edu_status: Option<&'static str>,
    pub edu_entered_on: Option<Date>,
    pub edu_ended_on: Option<Date>,
    pub qual_name: Option<String>,
    pub qual_kind: Option<&'static str>,
    pub qual_grade: Option<String>,
    pub qual_issuer: Option<String>,
    pub qual_number: Option<String>,
    pub qual_acquired_on: Option<Date>,
    pub qual_expires_on: Option<Date>,
    pub mil_status: Option<&'static str>,
    pub mil_branch: Option<&'static str>,
    pub mil_rank: Option<String>,
    pub mil_served_from: Option<Date>,
    pub mil_served_to: Option<Date>,
    pub trn_course: Option<String>,
    pub trn_provider: Option<String>,
    pub trn_status: Option<&'static str>,
    pub trn_started_on: Option<Date>,
    pub trn_ended_on: Option<Date>,
    pub trn_hours: Option<i32>,
    pub lang_language: Option<String>,
    pub lang_test: Option<String>,
    pub lang_score: Option<String>,
    pub lang_taken_on: Option<Date>,
    pub lang_expires_on: Option<Date>,
    pub rnd_title: Option<String>,
    pub rnd_decided_on: Option<Date>,
    pub rnd_issuer: Option<String>,
    pub rnd_details: Option<String>,
    pub rnd_ends_on: Option<Date>,
    pub fam_relation: Option<&'static str>,
    pub fam_name: Option<String>,
    pub fam_birth_date: Option<Date>,
    pub fam_cohabiting: Option<bool>,
    pub dis_severity: Option<&'static str>,
    pub dis_recognised_on: Option<Date>,
    pub vet_target: Option<&'static str>,
    pub vet_recognised_on: Option<Date>,
    pub basis: Option<&'static str>,
    pub basis_consent_on: Option<Date>,
    pub basis_statute: Option<&'static str>,
}

pub(super) fn cols(fields: &RecordFields) -> Cols {
    match fields.clone() {
        RecordFields::Education(v) => Cols {
            edu_school: Some(v.school),
            edu_level: Some(v.level.as_str()),
            edu_major: v.major,
            edu_status: Some(v.status.as_str()),
            edu_entered_on: v.entered_on,
            edu_ended_on: v.ended_on,
            ..Cols::default()
        },
        RecordFields::Qualification(v) => Cols {
            qual_name: Some(v.name),
            qual_kind: Some(v.kind.as_str()),
            qual_grade: v.grade,
            qual_issuer: v.issuer,
            qual_number: v.number,
            qual_acquired_on: v.acquired_on,
            qual_expires_on: v.expires_on,
            ..Cols::default()
        },
        RecordFields::Military(v) => Cols {
            mil_status: Some(v.status.as_str()),
            mil_branch: v.branch.map(MilBranch::as_str),
            mil_rank: v.rank,
            mil_served_from: v.served_from,
            mil_served_to: v.served_to,
            ..Cols::default()
        },
        RecordFields::Training(v) => Cols {
            trn_course: Some(v.course),
            trn_provider: v.provider,
            trn_status: Some(v.status.as_str()),
            trn_started_on: Some(v.started_on),
            trn_ended_on: v.ended_on,
            trn_hours: v.hours,
            ..Cols::default()
        },
        RecordFields::Language(v) => Cols {
            lang_language: Some(v.language),
            lang_test: v.test,
            lang_score: v.score,
            lang_taken_on: v.taken_on,
            lang_expires_on: v.expires_on,
            ..Cols::default()
        },
        RecordFields::Award(v) => Cols {
            rnd_title: Some(v.title),
            rnd_decided_on: Some(v.decided_on),
            rnd_issuer: v.issuer,
            rnd_details: v.details,
            ..Cols::default()
        },
        RecordFields::Discipline(v) => Cols {
            rnd_title: Some(v.title),
            rnd_decided_on: Some(v.decided_on),
            rnd_issuer: v.issuer,
            rnd_details: v.details,
            rnd_ends_on: v.ends_on,
            ..Cols::default()
        },
        RecordFields::Family(v) => Cols {
            fam_relation: Some(v.relation.as_str()),
            fam_name: Some(v.name),
            fam_birth_date: v.birth_date,
            fam_cohabiting: v.cohabiting,
            ..Cols::default()
        },
        RecordFields::Disability(v) => Cols {
            dis_severity: Some(v.severity.as_str()),
            dis_recognised_on: v.recognised_on,
            ..with_basis(v.basis)
        },
        RecordFields::Veteran(v) => Cols {
            vet_target: Some(v.target.as_str()),
            vet_recognised_on: v.recognised_on,
            ..with_basis(v.basis)
        },
    }
}

fn with_basis(basis: Basis) -> Cols {
    match basis {
        Basis::Consent { consent_on } => Cols {
            basis: Some("CONSENT"),
            basis_consent_on: Some(consent_on),
            ..Cols::default()
        },
        Basis::Statute { statute } => Cols {
            basis: Some("STATUTE"),
            basis_statute: Some(statute.as_str()),
            ..Cols::default()
        },
    }
}
