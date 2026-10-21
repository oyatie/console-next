//! Wire enums. Each is an official code list or a closed statutory choice;
//! the codes are what the API, the database CHECKs and the OpenAPI enums carry.

use crate::code_enum;

code_enum! {
    /// 사업자 구분 (공통서식 「사업장 형태」; 국세청 tax_type_cd 05/06 for 단체).
    BizKind { Corporation => "CORPORATION", Individual => "INDIVIDUAL", IdNumberOrg => "ID_NUMBER_ORG" }
}

code_enum! {
    /// How the 법인 is represented: 단독, 각자대표, 공동대표 (상법 §389②).
    RepresentationMode { Single => "SINGLE", Several => "SEVERAL", Joint => "JOINT" }
}

code_enum! {
    /// 법인등기 임원 구분.
    DirectorRole {
        RepresentativeDirector => "REPRESENTATIVE_DIRECTOR",
        InsideDirector => "INSIDE_DIRECTOR",
        OutsideDirector => "OUTSIDE_DIRECTOR",
        OtherNonExecutive => "OTHER_NON_EXECUTIVE",
        Auditor => "AUDITOR",
    }
}

code_enum! {
    /// 과세유형: 국세청 사업자등록 상태조회 `tax_type_cd` (verified 2026-10-02).
    NtsTaxType {
        General => "01",
        Simplified => "02",
        SpecialCase => "03",
        Exempt => "04",
        NonProfitNoRevenue => "05",
        IdNumberOrganization => "06",
        SimplifiedInvoiceIssuer => "07",
    }
}

code_enum! {
    /// 발급 사유 kind. No official list exists; the printed text is always kept.
    IssueReasonKind { New => "NEW", Reissue => "REISSUE", Correction => "CORRECTION", OtherAsPrinted => "OTHER_AS_PRINTED" }
}

code_enum! {
    /// Why a newly issued 사업자등록증 is recorded (등록증 재발급·정정): 재발급
    /// (lost or damaged, the facts unchanged), 정정 신고 (the facts changed
    /// from a date, 부가세법 §11), or 오류 정정 (the record was wrong from the
    /// start; the certificate is the evidence). The revision's reason code.
    CertificateRevisionReason {
        Reissue => "CERT_REISSUE",
        ChangeReport => "CERT_CHANGE_REPORT",
        ErrorCorrection => "CERT_ERROR_CORRECTION",
    }
}

code_enum! {
    /// 정정 sub-reason (부가세법 시행령 §14①).
    CorrectionReason {
        TradeName => "TRADE_NAME",
        Relocation => "RELOCATION",
        Industry => "INDUSTRY",
        UnitTaxation => "UNIT_TAXATION",
        Representative => "REPRESENTATIVE",
        Other => "OTHER",
    }
}

code_enum! {
    /// VAT unit of the 법인 (부가세법 §8③ 사업자단위과세, §51 주사업장 총괄납부).
    VatUnitMode { PerWorkplace => "PER_WORKPLACE", ConsolidatedPayment => "CONSOLIDATED_PAYMENT", UnitTaxation => "UNIT_TAXATION" }
}

code_enum! {
    /// Where `vat_unit_mode` came from: a declaration, or a fact (one
    /// registration; certificate ⑩ = Y). A derived fact is not a default.
    VatUnitBasis {
        Declared => "DECLARED",
        SingleRegistration => "SINGLE_REGISTRATION",
        CertificateUnitTaxation => "CERTIFICATE_UNIT_TAXATION",
    }
}

code_enum! {
    /// 원천징수 단위 of a 사업장 (소득세법 §7①3·4; 원천징수사무처리규정 §34).
    WithholdingMode { HeadOffice => "HEAD_OFFICE", OwnIndependentAccounts => "OWN_INDEPENDENT_ACCOUNTS", HeadOfficeBulk => "HEAD_OFFICE_BULK" }
}

code_enum! {
    /// Confirmed status of a registration or 사업장 (부가세법 §8⑧ 휴업·폐업).
    OperatingStatus { Continuing => "CONTINUING", Suspended => "SUSPENDED", Closed => "CLOSED" }
}

code_enum! {
    /// Why a 법인 closed (MR-15): 해산 (the 법인 is dissolved) or 폐업 (the
    /// business ends). Recorded with `legal_entities.closed_on`, once.
    CloseReason { Dissolved => "DISSOLVED", BusinessClosed => "BUSINESS_CLOSED" }
}

code_enum! {
    /// Why a 사업자등록번호 is not entered yet.
    BrnPendingReason { NewRegistrationPending => "NEW_REGISTRATION_PENDING" }
}

code_enum! {
    /// Why a registration is saved unverified (the `business_registrations`
    /// CHECK). The MVP never calls 국세청 (decisions #16): a typed number is
    /// `NOT_CHECKED` (「진위 확인: 하지 않음」), a missing one
    /// `NEW_REGISTRATION_PENDING`. `SERVICE_UNAVAILABLE` is kept for the
    /// post-MVP verifier and is never written today.
    UnverifiedReason {
        NewRegistrationPending => "NEW_REGISTRATION_PENDING",
        ServiceUnavailable => "SERVICE_UNAVAILABLE",
        NotChecked => "NOT_CHECKED",
    }
}

code_enum! {
    Insurer { Nps => "NPS", Nhis => "NHIS", Ei => "EI", Iaci => "IACI" }
}

code_enum! {
    /// 보험관계 status. ESTABLISHED_NUMBER_PENDING: 성립했지만 번호는 나중에
    /// (challenge A-8) — a to-do, no clock, blocks only the first 취득/상실 filing.
    InsuranceStatus {
        NotEstablished => "NOT_ESTABLISHED",
        Established => "ESTABLISHED",
        EstablishedNumberPending => "ESTABLISHED_NUMBER_PENDING",
        Ended => "ENDED",
    }
}

code_enum! {
    /// 분리적용 or part of the 주된 사업장 (공통서식).
    InsuranceUnitMode { Own => "OWN", PartOf => "PART_OF" }
}

code_enum! {
    NhisWorkplaceClass { One => "1", Three => "3", Five => "5", Seven => "7" }
}

code_enum! {
    IaciBusinessForm { Continuing => "CONTINUING", FixedTerm => "FIXED_TERM" }
}

code_enum! {
    /// 우선지원대상기업 (고용보험법 시행령 §12).
    PrioritySupport { Yes => "YES", No => "NO" }
}

code_enum! {
    PrioritySupportBasis { Annex1 => "ANNEX_1", SmeAct => "SME_ACT", Grace5y => "GRACE_5Y", NotEligible => "NOT_ELIGIBLE" }
}

code_enum! {
    /// Address provenance: a 도로명주소 search result, or structured manual entry
    /// (juso unavailable; re-matched later, shown with 「주소 검증 필요」).
    AddressSource { Juso => "JUSO", ManualUnverified => "MANUAL_UNVERIFIED" }
}

code_enum! {
    /// One-choice 4대보험 setup shortcut (no default).
    InsuranceShortcut {
        AllEstablishedNumbersLater => "ALL_ESTABLISHED_NUMBERS_LATER",
        AllEstablishedNow => "ALL_ESTABLISHED_NOW",
        NoneYet => "NONE_YET",
        PerInsurer => "PER_INSURER",
    }
}

code_enum! {
    /// Cause of an employment assignment row.
    AssignmentCause {
        Hire => "HIRE",
        Transfer => "TRANSFER",
        GroupTransfer => "GROUP_TRANSFER",
        Correction => "CORRECTION",
        SetupBind => "SETUP_BIND",
        Migration => "MIGRATION",
        MigrationUnmapped => "MIGRATION_UNMAPPED",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_round_trip_and_serde_uses_codes() {
        for t in NtsTaxType::ALL {
            assert_eq!(NtsTaxType::parse(t.as_str()), Some(*t));
        }
        assert_eq!(NtsTaxType::ALL.len(), 7);
        assert_eq!(
            serde_json::to_string(&NtsTaxType::Simplified).unwrap(),
            "\"02\""
        );
        assert_eq!(BizKind::parse("corporation"), None);
        assert_eq!(BizKind::parse(" CORPORATION "), Some(BizKind::Corporation));
    }
}
