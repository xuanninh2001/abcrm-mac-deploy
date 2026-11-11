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
      <form className="card" action="/auth/local/login" method="post">
        <input type="hidden" name="next" value={next ?? "/inbox"} />
        <p><label>Workspace<br /><input name="tenant" defaultValue="abcrm" required autoComplete="organization" /></label></p>
        <p><label>Email<br /><input name="email" type="email" required autoComplete="username" /></label></p>
        <p><label>Password<br /><input name="password" type="password" required maxLength={256} autoComplete="current-password" /></label></p>
        <button className="primary" type="submit">Sign in</button>
        <p className="muted small">Forgot your password? Contact your server administrator.</p>
      </form>
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
    </main>
  );
}
