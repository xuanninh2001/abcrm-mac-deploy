import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./brand.css";
import "./interactions.css";
import { FeedbackProvider } from "@/components/FeedbackProvider";

export const metadata: Metadata = { title: "Aurora | DB Media Groups", description: "Aurora CRM - your DB Media Groups workspace for sourcing, qualification and decisions" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body><FeedbackProvider>{children}</FeedbackProvider></body>
    </html>
  );
}
