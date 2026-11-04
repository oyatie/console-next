<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Payroll

## 7.2 Run creation

The server derives a run from its pay group; clients submit only the pay group
and run kind. Each kind has an independent month sequence. `REGULAR`,
`OFF_CYCLE`, `CORRECTION`, and `EXIT_SETTLEMENT` therefore use the first
unoccupied attribution month at or after the entity's current month for that
same group and kind. A void run releases its month. The derived pay date, base
period, and variable period are persisted on creation and never re-derived for
that run.
