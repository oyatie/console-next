<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# No IaC in this tree (yet)

Infrastructure as code for production lives in the private `oyatie/console-infra` repository today.
The platform migration (console-handoff units/platform, P0-NEXT) adds the GitOps `deploy/` tree here; when it lands,
this file is removed in the same change (the iac-tier gate refuses both at once).
