// SPDX-License-Identifier: LicenseRef-Proprietary
//! One set of placement and physical-site targets shared by both import flows.

use super::fields::EmployeeImportFieldDefinition;

pub(super) const ORG_UNIT: EmployeeImportFieldDefinition = EmployeeImportFieldDefinition {
    target: "org_unit",
    aliases: &[
        "본부",
        "부문",
        "부",
        "실",
        "파트",
        "과",
        "그룹",
        "division",
        "sector",
        "part",
        "section",
        "group",
        "unit",
        "부서명",
        "부서",
        "소속",
        "소속부서",
        "조직",
        "팀",
        "org_unit",
        "orgunit",
        "department",
        "dept",
        "team",
    ],
    classification: "canonical",
    required: false,
};

pub(super) const WORKPLACE: EmployeeImportFieldDefinition = EmployeeImportFieldDefinition {
    target: "workplace",
    aliases: &[
        "사업장",
        "사업장명",
        "사업소",
        "근무사업장",
        "workplace",
        "workplace_name",
    ],
    classification: "canonical",
    required: false,
};

pub(super) const WORKSITE_NAME: EmployeeImportFieldDefinition = EmployeeImportFieldDefinition {
    target: "worksite_name",
    aliases: &["근무지", "현장", "현장명", "worksite", "site"],
    classification: "canonical",
    required: false,
};

pub(super) const WORKSITE_ADDRESS: EmployeeImportFieldDefinition = EmployeeImportFieldDefinition {
    target: "worksite_address",
    aliases: &[
        "근무지(주소)",
        "근무지주소",
        "근무지주소지",
        "현장주소",
        "사업장주소",
        "worksite_address",
        "worksiteaddress",
        "workplace_address",
        "workplaceaddress",
        "site_address",
        "siteaddress",
    ],
    classification: "location",
    required: false,
};
