import s from "./tabs.module.css";

/**
 * The tab look for a route link inside TabNav: `<Link className={tabClass}>` (the router marks the active one
 * aria-current="page"); a link whose section holds the current page takes aria-current="true".
 */
export const tabClass = s.tab;
