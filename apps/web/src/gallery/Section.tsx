import type { ReactNode } from "react";

/** One gallery entry's card: a heading over the component's states. */
export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="card gallery__section">
    <h2 className="toolbar__title">{title}</h2>
    {children}
  </section>
);
