import { config, devAuthEnabled } from "@/lib/config";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  signin_failed: "Sign-in failed. Try again.",
  workos_not_configured: "Single sign-on is not configured on this server.",
  invalid_ids: "Tenant and user must be UUIDs.",
  unknown_user: "That tenant/user pair is not an active user.",
};

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <main className="main" style={{ maxWidth: 420, margin: "10vh auto" }}>
      <h1>Sign in to ABCRM</h1>
      {error && <p className="error" role="alert">{ERRORS[error] ?? "Sign-in failed."}</p>}
      {config.workos && (
        <p><a className="btn" href={`/auth/signin?next=${encodeURIComponent(next ?? "/inbox")}`}>Continue with WorkOS</a></p>
      )}
      {devAuthEnabled() && (
        <form className="card" action="/dev-login" method="post">
          <h2>Dev sign-in</h2>
          <p className="muted small">Local and CI only. Uses the API's dev tokens.</p>
          <input type="hidden" name="next" value={next ?? "/inbox"} />
          <p><label>Tenant ID<br /><input name="tenant_id" required size={40} /></label></p>
          <p><label>User ID<br /><input name="user_id" required size={40} /></label></p>
          <button className="primary" type="submit">Sign in</button>
        </form>
      )}
      {!config.workos && !devAuthEnabled() && <p className="muted">No sign-in method is configured (set WORKOS_API_KEY and WORKOS_CLIENT_ID).</p>}
    </main>
  );
}
