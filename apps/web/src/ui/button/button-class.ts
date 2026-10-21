/**
 * primary: the view's one commit · secondary: everything else · ghost: tertiary · danger: an irreversible
 * commit inside the dialog that confirms it · ghost-danger: a quiet entry to an irreversible act · link: a command
 * inside a line of text (a reservation's cancel in a history row), the app.css `.link` look on a button.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "ghost-danger" | "link";
/** md: the default 36 px control · sm: 32 px (`--target`), for a row's verbs, a panel's tools and a toolbar's filters. */
export type ButtonSize = "md" | "sm";

const CLASS: Record<ButtonVariant, string> = {
  primary: "btn btn--primary",
  secondary: "btn",
  ghost: "btn btn--ghost",
  danger: "btn btn--danger",
  "ghost-danger": "btn btn--ghost btn--danger",
  link: "link",
};

/**
 * The button look as a class list, for the one control that cannot be a Button: a router link that reads as a
 * command (`<Link className={buttonClass("primary")}>`). Everything else renders Button.
 */
export const buttonClass = (variant: ButtonVariant = "secondary", o: { size?: ButtonSize; icon?: boolean; className?: string } = {}) =>
  [CLASS[variant], o.size === "sm" && "btn--sm", o.icon && "btn--icon", o.className].filter(Boolean).join(" ");
