// SPDX-License-Identifier: LicenseRef-Proprietary
permit(principal is Ops::Operator, action, resource is Ops::Console)
when {
    principal.grants.contains(context.grant) &&
    context.grant.action == action &&
    context.grant.from <= context.now &&
    context.now < context.grant.until
};
