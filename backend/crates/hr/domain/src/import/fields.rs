//! The employee import target catalog: canonical targets, their header
//! aliases and classification (moved from `app/src/hr.rs`, R2-import).

use super::{fields_place, fields_register};

#[derive(Debug)]
pub struct EmployeeImportFieldDefinition {
    pub target: &'static str,
    pub aliases: &'static [&'static str],
    pub classification: &'static str,
    pub required: bool,
}

pub const EMPLOYEE_IMPORT_FIELD_DEFINITIONS: &[EmployeeImportFieldDefinition] = &[
    EmployeeImportFieldDefinition {
        target: "name",
        aliases: &[
            "성명",
            "이름",
            "직원명",
            "사원명",
            "근로자명",
            "임직원명",
            "name",
            "employee_name",
            "employeename",
            "worker_name",
            "workername",
        ],
        classification: "canonical",
        required: true,
    },
    EmployeeImportFieldDefinition {
        target: "employee_number",
        aliases: &[
            "사번",
            "사원번호",
            "직원번호",
            "사용자ID",
            "user_id",
            "userid",
            "employee_id",
            "employeeid",
            "employee_number",
            "employeenumber",
            "staff_id",
            "staffid",
        ],
        classification: "canonical",
        required: false,
    },
    fields_place::ORG_UNIT,
    EmployeeImportFieldDefinition {
        target: "job",
        aliases: &[
            "업무",
            "담당업무",
            // r3:records-02: 근로자 명부 「종사하는 업무의 종류」.
            "종사업무",
            "종사하는업무",
            "직무",
            "직종",
            "job",
            "work_type",
            "worktype",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "position",
        // r3:hire-16: 직급 (a grade) is not 직위 (a post); it stays 원본만 보관
        // rather than overwriting the person's 직위.
        aliases: &["직책", "직위", "직함", "position", "title"],
        classification: "canonical",
        required: false,
    },
    fields_place::WORKPLACE,
    fields_place::WORKSITE_NAME,
    fields_place::WORKSITE_ADDRESS,
    EmployeeImportFieldDefinition {
        target: "hire_date",
        aliases: &[
            "입사일",
            "입사일자",
            "채용일",
            "보험가입일",
            "hire_date",
            "hiredate",
            "start_date",
            "startdate",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "exit_date",
        aliases: &[
            "퇴사일",
            "퇴사일자",
            "퇴직일",
            "보험상실일",
            "exit_date",
            "exitdate",
            "end_date",
            "enddate",
            "termination_date",
            "terminationdate",
        ],
        classification: "canonical",
        required: false,
    },
    // BW-10 / decisions #6: 생년월일 is the identity discriminator and a 명부
    // fact (근기법 시행령 §20), so this column is kept, typed and checked.
    // r3:hire-16 / records-02: 근로자 명부 (근기법 시행령 §20) facts.
    fields_register::SEX,
    fields_register::CONTRACT_END_DATE,
    fields_register::PROBATION_END_DATE,
    EmployeeImportFieldDefinition {
        target: "birth_date",
        aliases: &[
            "생년월일",
            "birth_date",
            "birthdate",
            "date_of_birth",
            "dob",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "leave_accrued",
        aliases: &[
            "발생연차",
            "연차발생",
            "부여연차",
            "발생휴가",
            "leave_accrued",
            "leaveaccrued",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "leave_used",
        aliases: &[
            "사용연차",
            "연차사용",
            "사용휴가",
            "leave_used",
            "leaveused",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "leave_remaining",
        aliases: &[
            "잔여연차",
            "남은연차",
            "연차잔여",
            "잔여휴가",
            "leave_balance",
            "leavebalance",
            "leave_remaining",
            "leaveremaining",
        ],
        classification: "canonical",
        required: false,
    },
    // MR-7: 고용형태, recorded on the employment profile. A code maps as is;
    // a label (정규직, 촉탁) is mapped by the operator, since the labels live
    // in the client catalogs.
    EmployeeImportFieldDefinition {
        target: "employment_type",
        aliases: &[
            "고용형태",
            "고용구분",
            "고용유형",
            "계약형태",
            "employment_type",
            "employmenttype",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "company_brn",
        aliases: &[
            "사업자등록번호",
            "등록번호",
            "company_brn",
            "registration_number",
            "registration number",
            "business registration number",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "company",
        aliases: &[
            "회사",
            "법인",
            "회사명",
            "법인명",
            "company name",
            "entity",
            "소속회사",
            "계열사",
            "조직회사",
            "company",
            "corporation",
            "legal_entity",
            "legalentity",
        ],
        classification: "canonical",
        required: false,
    },
    // IMPORT-2 (decisions #25): sealed at the parse, matched by keyed hash,
    // never stored in a raw row ("restricted").
    EmployeeImportFieldDefinition {
        target: "rrn",
        aliases: &[
            "주민등록번호",
            "주민번호",
            "rrn",
            "resident_registration_number",
        ],
        classification: "restricted",
        required: false,
    },
    // W12: the person's 휴대전화 (restricted; stored on the profile at apply).
    fields_register::PHONE,
    // IMPORT-2 (decisions #26): the current status and a 휴직's start, recorded
    // as setup facts.
    EmployeeImportFieldDefinition {
        target: "employment_status",
        aliases: &[
            "재직상태",
            "재직구분",
            "재직여부",
            "근무상태",
            "employment_status",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "leave_start_date",
        aliases: &["휴직시작일", "휴직개시일", "휴직일", "leave_start_date"],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "leave_type",
        aliases: &["휴직구분", "휴직유형", "휴직종류", "leave_type"],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "leave_return_date",
        aliases: &[
            "복직예정일",
            "복귀예정일",
            "휴직종료예정일",
            "expected_return_date",
        ],
        classification: "canonical",
        required: false,
    },
];

#[cfg(test)]
#[path = "fields_tests.rs"]
mod tests;
