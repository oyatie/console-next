<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Status bar

`StatusBar` is a `24px` static footer strip inside the desktop application frame (`[data-surface="chrome"]`) that displays scope, sync, attention, and shortcut facts.

It lives in `apps/web/src/ui/status-bar`: the component in `status-bar.tsx`, its styles in `status-bar.module.css`, and its gallery entry in `status-bar.gallery.tsx`.

## When to use it, and when not

Use it once at the bottom of the desktop application shell to display persistent workspace facts.

| Do not use it for | Use instead |
|---|---|
| Transient command receipts or live announcements | `Receipt` or `Banner`: see [Receipt](receipt.md) and [Banner](banner.md). |
| Sticky form submission controls | `ActionBar`: see [Action bar](action-bar.md). |

## Anatomy

- **Landmark:** `<footer aria-label={label} data-surface="chrome">`.
- **Leading segments:** inline list of `StatusBarSegment` items separated by `--space-5` (`24px`), with index `0` defaulting to `tone="strong"`.
- **Trailing slot:** optional right-aligned content (`margin-inline-start: auto`) for secondary metadata. In the desk shell it is the screen's: `useScreenStatusBar(segments, trailing)` publishes it. The trailing fact and the segments are owned apart, so a screen can publish its fact while its pattern publishes the segments; each leaves with the component that published it.

## Looks and sizes

One compact height (`min-height: var(--space-5)`, `24px`) with `--text-xs` (`12px`) tabular text and a `1px solid var(--border)` (`--chrome-border`) top hairline:

| `tone` | Text colour and weight | Typical use |
|---|---|---|
| `strong` (default on index `0`) | `--ink` (`--on-chrome`), `--fw-semibold` | Active tenant or scope summary. |
| `default` | `--steel` (`--on-chrome-muted`), regular weight | Counts, period, or connection state. |
| `attention` | `--warn-tx` (`--chrome-attention`), `--fw-semibold` | Overdue items or pending exceptions. |

## States

There is no hover, focus, pressed, selected, disabled, read-only, invalid, or loading state on `StatusBar`. When both `segments` and `trailing` are empty, it renders nothing.

## Keyboard

None. `StatusBar` is static text; if a caller places an interactive control in `trailing`, that control keeps its own focus ring and keyboard contract.

## Accessibility contract

- **Role:** `contentinfo` landmark (`<footer>`) named by `label` (defaulting to `shell.status.label`).
- **Announced:** never carries `aria-live`, preventing background status updates from interrupting screen reader speech.
- **WCAG 2.2:** 1.4.3 Contrast (Minimum) holds across light and dark themes for `--on-chrome`, `--on-chrome-muted`, and `--chrome-attention` against `--chrome`.

## Phone behaviour at 390 px

Phone shells omit `StatusBar` (`--statusbar-h: 0px`), giving full vertical room to content and `PhoneBottomNav`.

## Copy rules

`label` defaults to `shell.status.label` from `@console/i18n`; segment text is supplied by the shell or screen from catalog ids and formatted helpers.

## Props

<!-- ds:props apps/web/src/ui/status-bar/status-bar.tsx -->

### StatusBar

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `segments` | yes | `readonly StatusBarSegment[]` |  | Leading status segments; index `0` defaults to `tone="strong"` when `tone` is omitted. |
| `label` | no | `string` |  | Accessible name of the status bar footer landmark; defaults to `shell.status.label`. |
| `trailing` | no | `ReactNode` |  | Optional right-aligned segment placed after the flexible spacer. |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/status-bar/status-bar.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border-block-start` |
| `--fw-semibold` | `font-weight` |
| `--ink` | `color` |
| `--space-1-5` | `gap` |
| `--space-2` | `gap` |
| `--space-4` | `padding` |
| `--space-5` | `gap`, `min-height` |
| `--steel` | `color` |
| `--text-xs` | `font-size` |
| `--warn-tx` | `color` |

<!-- /ds:tokens -->
