//! What a grant line does NOT reach over a scope narrower than the tenant
//! (AX-5), as stable codes the screens word: every HR door decides per person
//! over the grant set, and these doors stay whole-tenant (a holder gets the
//! typed `scope_tenant_wide_only`). A 전체 grant has no caveat.

use console_platform_authz::access::{Domain, Level, NodeKind};

/// The caveat codes of one (domain, level) line over a `kind` scope.
#[must_use]
pub fn caveats(domain: Domain, level: Level, kind: NodeKind) -> Vec<&'static str> {
    if kind == NodeKind::Tenant {
        return Vec::new();
    }
    match (domain, level) {
        // 명부·인사카드·이력은 이 범위 안 사람만.
        (Domain::HrBasic, Level::View) => vec!["scope_people"],
        // 등록은 이 범위 안으로만; 명부 가져오기, 사번 규칙·일괄 변경, 일괄
        // 정정, 동일인 병합, 변경 묶음은 전체 권한만.
        (Domain::HrBasic, Level::Edit) => vec!["scope_register", "tenant_wide_hr_basic"],
        (Domain::HrBasic, Level::Export) => vec!["scope_export"],
        // 여러 명 한꺼번에 발령하기는 전체 권한만.
        (Domain::Appointment, Level::Edit) => vec!["scope_people", "tenant_wide_bulk_appointment"],
        // 퇴직 보고·인사 확인은 범위 안 사람; 정산·종결은 아직 지점 기준.
        (Domain::Exit, Level::Edit) => vec!["scope_people", "exit_settlement_branch"],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tenant_grant_has_no_caveat_and_a_scoped_hr_edit_names_the_tenant_wide_doors() {
        assert!(caveats(Domain::HrBasic, Level::Edit, NodeKind::Tenant).is_empty());
        assert_eq!(
            caveats(Domain::HrBasic, Level::Edit, NodeKind::LegalEntity),
            ["scope_register", "tenant_wide_hr_basic"]
        );
        assert_eq!(
            caveats(Domain::Appointment, Level::Edit, NodeKind::Department),
            ["scope_people", "tenant_wide_bulk_appointment"]
        );
        assert!(caveats(Domain::Access, Level::Edit, NodeKind::Workplace).is_empty());
    }
}
