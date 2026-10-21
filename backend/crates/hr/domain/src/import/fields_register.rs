//! r3:hire-16 / records-02: the 근로자 명부 (근기법 시행령 §20) targets of the
//! import catalog — facts a new person's first records take — and the
//! 휴대전화 the register sheet needs (W12: stored E.164 on the employment
//! profile at apply; never in a raw row or a preview, "restricted").

use super::fields::EmployeeImportFieldDefinition;

pub(super) const SEX: EmployeeImportFieldDefinition = EmployeeImportFieldDefinition {
    target: "sex",
    aliases: &["성별", "남녀", "sex", "gender"],
    classification: "canonical",
    required: false,
};

pub(super) const CONTRACT_END_DATE: EmployeeImportFieldDefinition = EmployeeImportFieldDefinition {
    target: "contract_end_date",
    aliases: &[
        "계약종료일",
        "계약만료일",
        "계약기간종료일",
        "계약종료",
        "contract_end",
        "contract_end_date",
    ],
    classification: "canonical",
    required: false,
};

pub(super) const PROBATION_END_DATE: EmployeeImportFieldDefinition =
    EmployeeImportFieldDefinition {
        target: "probation_end_date",
        aliases: &[
            "수습종료일",
            "수습만료일",
            "수습기간종료일",
            "수습종료",
            "probation_end",
            "probation_end_date",
        ],
        classification: "canonical",
        required: false,
    };

pub(super) const PHONE: EmployeeImportFieldDefinition = EmployeeImportFieldDefinition {
    target: "phone",
    aliases: &[
        "휴대폰",
        "휴대폰번호",
        "휴대전화",
        "휴대전화번호",
        "핸드폰",
        "핸드폰번호",
        "연락처",
        "전화번호",
        "전화",
        "phone",
        "phone_number",
        "mobile",
    ],
    classification: "restricted",
    required: false,
};
