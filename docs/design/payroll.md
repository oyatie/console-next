<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Payroll

## 7.2 Run creation

The server accepts only `REGULAR`; clients submit the pay group and kind.
It derives the first unoccupied attribution month at or after the entity's
current month for that group. A void regular run releases its month. The pay
date, base period and variable period are persisted and never re-derived.
Creation requires an operating tenant; setup refuses with `phase_not_operating`.
Other kinds refuse preview and creation with `run_kind_unsupported` (422).

The next slice adds sequence identity and explicit inputs: `OFF_CYCLE` uses an
explicit attribution month and reason, `CORRECTION` an explicit past attribution
month, and `EXIT_SETTLEMENT` a person and exit package. They cannot use the
regular run's month derivation.
