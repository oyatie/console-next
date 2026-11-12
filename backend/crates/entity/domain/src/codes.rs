//! Wire enums. Each is an official code list or a closed statutory choice;
//! the codes are what the API, the database CHECKs and the OpenAPI enums carry.

use crate::code_enum;

code_enum! {
    /// Business type (the common form's "workplace type"; National Tax Service
    /// tax_type_cd 05/06 for organisations).
    BizKind { Corporation => "CORPORATION", Individual => "INDIVIDUAL", IdNumberOrg => "ID_NUMBER_ORG" }
}

code_enum! {
    /// How the legal entity is represented: sole, separate (independent)
    /// representatives, co-representatives (Commercial Act §389②).
    RepresentationMode { Single => "SINGLE", Several => "SEVERAL", Joint => "JOINT" }
}

code_enum! {
    /// Executive role as entered in the corporate registry.
    DirectorRole {
        RepresentativeDirector => "REPRESENTATIVE_DIRECTOR",
        InsideDirector => "INSIDE_DIRECTOR",
        OutsideDirector => "OUTSIDE_DIRECTOR",
        OtherNonExecutive => "OTHER_NON_EXECUTIVE",
        Auditor => "AUDITOR",
    }
}

code_enum! {
    /// Taxation type: the National Tax Service business registration status
    /// lookup's `tax_type_cd` (verified 2026-10-02).
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
    /// Issue reason kind. No official list exists; the printed text is always kept.
    IssueReasonKind { New => "NEW", Reissue => "REISSUE", Correction => "CORRECTION", OtherAsPrinted => "OTHER_AS_PRINTED" }
}

code_enum! {
    /// Why a newly issued business registration certificate is recorded
    /// (certificate reissue / correction): reissue (lost or damaged, the facts
    /// unchanged), correction report (the facts changed from a date, VAT Act
    /// §11), or error correction (the record was wrong from the start; the
    /// certificate is the evidence). The revision's reason code.
    CertificateRevisionReason {
        Reissue => "CERT_REISSUE",
        ChangeReport => "CERT_CHANGE_REPORT",
        ErrorCorrection => "CERT_ERROR_CORRECTION",
    }
}

code_enum! {
    /// Correction sub-reason (Enforcement Decree of the VAT Act §14①).
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
    /// VAT unit of the legal entity (VAT Act §8③ business-unit taxation, §51
    /// principal-workplace consolidated payment).
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
    /// Withholding unit of a workplace (Income Tax Act §7①3·4; Withholding Tax
    /// Administration Regulation §34).
    WithholdingMode { HeadOffice => "HEAD_OFFICE", OwnIndependentAccounts => "OWN_INDEPENDENT_ACCOUNTS", HeadOfficeBulk => "HEAD_OFFICE_BULK" }
}

code_enum! {
    /// Confirmed status of a registration or workplace (VAT Act §8⑧ business
    /// suspension / closure).
    OperatingStatus { Continuing => "CONTINUING", Suspended => "SUSPENDED", Closed => "CLOSED" }
}

code_enum! {
    /// Why a legal entity closed (MR-15): dissolution (the legal entity is
    /// dissolved) or business closure (the business ends). Recorded with
    /// `legal_entities.closed_on`, once.
    CloseReason { Dissolved => "DISSOLVED", BusinessClosed => "BUSINESS_CLOSED" }
}

code_enum! {
    /// Why a business registration number is not entered yet.
    BrnPendingReason { NewRegistrationPending => "NEW_REGISTRATION_PENDING" }
}

code_enum! {
    /// Why the current number has no issuing-authority evidence. Derived on read.
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
    /// Insurance relationship status. ESTABLISHED_NUMBER_PENDING: established,
    /// but the number comes later (challenge A-8) — a to-do, no clock, blocks
    /// only the first acquisition / loss filing.
    InsuranceStatus {
        NotEstablished => "NOT_ESTABLISHED",
        Established => "ESTABLISHED",
        EstablishedNumberPending => "ESTABLISHED_NUMBER_PENDING",
        Ended => "ENDED",
    }
}

code_enum! {
    /// Separate application or part of the main workplace (common form).
    InsuranceUnitMode { Own => "OWN", PartOf => "PART_OF" }
}

code_enum! {
    NhisWorkplaceClass { One => "1", Three => "3", Five => "5", Seven => "7" }
}

code_enum! {
    IaciBusinessForm { Continuing => "CONTINUING", FixedTerm => "FIXED_TERM" }
}

code_enum! {
    /// Priority support enterprise (Enforcement Decree of the Employment
    /// Insurance Act §12).
    PrioritySupport { Yes => "YES", No => "NO" }
}

code_enum! {
    PrioritySupportBasis { Annex1 => "ANNEX_1", SmeAct => "SME_ACT", Grace5y => "GRACE_5Y", NotEligible => "NOT_ELIGIBLE" }
}

code_enum! {
    /// Address provenance: a road-name address search result, or structured
    /// manual entry (juso unavailable; re-matched later, shown with "address needs verification").
    AddressSource { Juso => "JUSO", ManualUnverified => "MANUAL_UNVERIFIED" }
}

code_enum! {
    /// One-choice setup shortcut for the four social insurances (no default).
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
