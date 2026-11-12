import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./brand.css";

export const metadata: Metadata = { title: "Aurora | DB Media Groups", description: "Aurora CRM - your DB Media Groups workspace for sourcing, qualification and decisions" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
