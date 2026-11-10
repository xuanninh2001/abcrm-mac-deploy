/** RFC 9457 problem types used by the API (docs/specs/phase-0-1/api.md §1). */
export type ProblemType =
  | "validation-failed" | "not-found" | "permission-denied" | "unauthenticated" | "quota-exhausted"
  | "gate-required" | "conflict" | "precondition-failed" | "rate-limited" | "internal";

const STATUS: Record<ProblemType, number> = {
  "validation-failed": 422, "not-found": 404, "permission-denied": 403, unauthenticated: 401,
  "quota-exhausted": 402, "gate-required": 409, conflict: 409, "precondition-failed": 412,
  "rate-limited": 429, internal: 500,
};

export class Problem extends Error {
  readonly status: number;
  constructor(readonly type: ProblemType, readonly title: string, readonly extra: Record<string, unknown> = {}) {
    super(title);
    this.status = STATUS[type];
  }

  toJSON(instance?: string) {
    return { type: `https://docs.abcrm.app/errors/${this.type}`, title: this.title, status: this.status, instance, ...this.extra };
  }
}

export const notFound = (what = "Resource") => new Problem("not-found", `${what} not found`);
