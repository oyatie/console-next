/** A ref that focuses its element when it mounts (an editor the user just opened), never again on re-render. */
export const focusOnce = (el: HTMLElement | null) => {
  if (el && !el.dataset.focused) {
    el.dataset.focused = "1";
    el.focus();
  }
};
