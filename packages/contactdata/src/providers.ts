/** A person as returned by a contact data vendor. Phone numbers are never requested or kept (D26). */
export type ProviderPerson = {
  firstName: string;
  lastName: string;
  title: string;
  email: string;
  linkedinUrl?: string;
  /** Provider's own reference, kept for license attribution. */
  ref?: string;
};

export type EmailCheck = "valid" | "catch_all" | "invalid" | "unknown";

/** Contact finder adapter (ADR-015). One adapter per signed vendor; enabled and ordered by `data_providers`. */
export interface ContactProvider {
  readonly key: string;
  find(domain: string, titles: string[], limit: number): Promise<{ people: ProviderPerson[]; costUsdMicros: number }>;
}

export interface EmailVerifier {
  readonly key: string;
  verify(email: string): Promise<{ result: EmailCheck; costUsdMicros: number }>;
}

/** Fixture provider for dev, tests and demos: people per domain. */
export class StaticContactProvider implements ContactProvider {
  calls = 0;
  constructor(readonly key: string, private readonly byDomain: Record<string, ProviderPerson[]>, private readonly costPerCall = 0) {}
  async find(domain: string, _titles: string[], limit: number) {
    this.calls++;
    return { people: (this.byDomain[domain] ?? []).slice(0, Math.max(limit * 5, 10)), costUsdMicros: this.costPerCall };
  }
}

export class StaticVerifier implements EmailVerifier {
  calls = 0;
  constructor(readonly key: string, private readonly results: Record<string, EmailCheck> = {}, private readonly fallback: EmailCheck = "valid") {}
  async verify(email: string) {
    this.calls++;
    return { result: this.results[email.toLowerCase()] ?? this.fallback, costUsdMicros: 0 };
  }
}
