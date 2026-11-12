"use client";
import type { ButtonHTMLAttributes } from "react";
import { LoaderCircle } from "lucide-react";

export function Button({ busy, children, disabled, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <button {...props} type={type} disabled={disabled || busy} aria-busy={busy || undefined}>
    {busy && <LoaderCircle size={16} className="loading-icon" aria-hidden="true" />}{children}
  </button>;
}
