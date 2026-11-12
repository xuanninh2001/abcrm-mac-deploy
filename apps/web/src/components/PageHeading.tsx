import type { ReactNode } from "react";

export function PageHeading({ title, description, eyebrow }: { title: ReactNode; description: string; eyebrow: string }) {
  return <header className="page-heading"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{description}</p></header>;
}
