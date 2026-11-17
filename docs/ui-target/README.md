# UI target

This folder is the target look of the console's web app: the boards a screen is built to match, the token values they were drawn with, and the rule for when a screen counts as done. Behaviour (what a screen does, its rules and refusals) is defined by the product documents and tests; this folder defines how it looks and is arranged.

## Styles

| Style | Status | Boards |
|---|---|---|
| **Control room** | The default, at every width. Built first, through every module. | [boards/d](boards/d) |
| **Warm clear** | A complete second style, desk and phone, that a tenant or a person can switch to. Built after Control room covers every module. | [boards/c](boards/c) |
| A third style | Later, from its own boards. | none yet |

- **Who chooses.** An admin sets the tenant's default style; each person can override it for themselves. With neither set, Control room applies.
- **The existing screen-style switch stays.** Today's look stays selectable beside the new styles until Control room is signed off, then it is removed.
- **One product, several arrangements.** Every style shows the same screens, data, commands, routes, roles and accessible names. A style changes tokens, the shell, and where a page's regions sit. It never changes what a screen does.

## Boards

Each board is a light-theme picture of one screen filled with the synthetic tenant (below), drawn on 2026-11-10.

| Screen | Control room | Warm clear |
|---|---|---|
| Home: work list | [1440](boards/d/1440/home.png) | [1440](boards/c/1440/home.png) |
| People list with the employee record panel | [1440](boards/d/1440/people.png) | [1440](boards/c/1440/people.png) |
| Approval document and decision | [1440](boards/d/1440/approval.png) | [1440](boards/c/1440/approval.png) |
| Attendance month | [1440](boards/d/1440/attendance.png) | [1440](boards/c/1440/attendance.png) |
| Payroll run | [1440](boards/d/1440/payroll.png) | [1440](boards/c/1440/payroll.png) |
| My profile (employee, phone) | [390](boards/d/390/profile.png) | [390](boards/c/390/profile.png) |
| Leave request (employee, phone) | [390](boards/d/390/leave.png) | [390](boards/c/390/leave.png) |
| Payslip (employee, phone) | [390](boards/d/390/payslip.png) | [390](boards/c/390/payslip.png) |

[manifest.json](manifest.json) lists every board with its style, screen, module, width, pixel size, theme and token file.

## Tokens

- [tokens/control-room.board.css](tokens/control-room.board.css) and [tokens/warm-clear.board.css](tokens/warm-clear.board.css) hold the values the boards were drawn with, light theme only, with a comment on each role.
- The app's own token files live under `packages/tokens/`. Where a style's app tokens exist, they are the source of truth and must match these board values in light theme; a change to a board value is a deliberate design change, shown in the PR.
- Colours are named by role (surface, text, line, accent, status), never by hue, so a style can change hue without touching a screen.

## What the boards do not show

The boards are the bar where they exist. Where they are silent, the screen is designed in the same style's language and shown in its PR for sign-off:

- **Screens with no board** (organization, appointments, statutory filings and registers, certificates and documents, settings and permissions, the access log, import and data checks, my team, sign-in and invite, the hire and exit flows, and admin screens on a phone): designed in the style's language from the nearest board.
- **Dark theme:** derived from the style's tokens; every colour a style sets in light is also set in dark; contrast holds at WCAG AA.
- **States:** empty, loading, failed, no permission, and the step-up before an identifier is shown or entered. Each list, record and form shows all of them.
- **Widths between 390 and 1440:** the desk arrangement stays usable down to the narrowest desk width the app supports, and the phone arrangement takes over below it. The PR states the breakpoint and shows both sides of it.

## Done for a screen

1. Required CI is green.
2. The PR shows the built screen beside its board, or beside the nearest board for an unboarded screen: at 1440 and at 390, in light and in dark.
3. The screen's journeys pass in Chromium and Firefox.
4. Nothing the screen did before is lost: every existing behaviour, state and test still holds.
5. The screen is signed off from the PR and the running app, and finally on the production test tenant after a release.

## Synthetic data

Every name, number and date on the boards is made up.

- The people, structure and figures come from a seeded generator for one fictional tenant, Saeon Group (5 companies, 40 workplaces, about 2,000 people). Four supporting names (the signed-in admin and a few approvers) were written for the boards and belong to no one.
- Identifiers appear only masked, as the product shows them: a registration number as `YYMMDD-N●●●●●●` derived from the generated birth date, a mobile number as `010-●●●●-NNNN`. No full identifier exists in the boards or their data.
- Company and business registration numbers in the generator pass the format and checksum rules by design, with `1234x` serials that mark them as made up.
- The mock API, the screenshots and the local seed should use this same tenant, so a built screen shows the same facts as its board. Today only some tests use its names; one shared fixture is part of the work. Where it needs registration numbers it uses unallocated `000` prefixes, never a real-shaped number.
