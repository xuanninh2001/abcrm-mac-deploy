import type { ErrorHandler } from "hono";
import { ZodError } from "zod";
import { Problem } from "@abcrm/core";

export const onError: ErrorHandler = (err, c) => {
  let problem: Problem;
  if (err instanceof Problem) problem = err;
  else if (err instanceof ZodError) problem = new Problem("validation-failed", "Request validation failed", { issues: err.issues });
  else if ((err as { code?: string }).code === "22P02") problem = new Problem("not-found", "Resource not found");   // malformed uuid
  else {
    // Log what identifies the failure, not the whole error: Postgres `detail`/`where` and driver objects can carry
    // row values (emails, names) that must not reach logs (test-plan.md §7, redaction).
    const e = err as { code?: string; name?: string; message?: string; stack?: string };
    console.error(JSON.stringify({ level: "error", path: c.req.path, request_id: c.res.headers.get("x-request-id") ?? undefined,
      name: e.name, code: e.code, message: e.message?.slice(0, 500), stack: e.stack?.split("\n").slice(1, 6).join("\n") }));
    problem = new Problem("internal", "Internal error");
  }
  return c.json(problem.toJSON(c.req.path), problem.status as 400, { "content-type": "application/problem+json" });
};
