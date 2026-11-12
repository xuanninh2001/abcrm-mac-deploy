import { config, devAuthEnabled } from "@/lib/config";
import { PasswordInput } from "@/components/PasswordInput";

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
    <main className="login-page">
      <section className="login-brand" aria-label="Aurora by DB Media Groups">
        <img src="/brand/dbmg.svg" alt="DBMG" width="170" height="48" />
        <div className="login-brand-copy"><p className="eyebrow">YOUR CRM WORKSPACE</p><p className="login-wordmark">Aurora<span>.</span></p><p>Source. Qualify. Connect.</p><span className="login-brand-description">Your buyers, team and decisions.<br />One connected workspace.</span></div>
        <div className="brand-orbit" aria-hidden="true"><span /><span /><span /></div>
        <p className="login-brand-footer">DIGITAL BUSINESS MEDIA GROUP</p>
      </section>
      <section className="login-panel" aria-label="Sign in">
      <div className="login-form-wrap">
      <p className="eyebrow">WELCOME BACK</p>
      <h1>Sign in to Aurora</h1>
      <p className="muted login-intro">Enter your workspace details to continue.</p>
      {error && <p className="error form-alert" role="alert">{ERRORS[error] ?? "Sign-in failed."}</p>}
      <form className="login-form" action="/auth/local/login" method="post">
        <input type="hidden" name="next" value={next ?? "/inbox"} />
        <p><label htmlFor="tenant">Workspace</label><input id="tenant" name="tenant" defaultValue="abcrm" required autoComplete="organization" autoCapitalize="none" spellCheck={false} /></p>
        <p><label htmlFor="email">Email</label><input id="email" name="email" type="email" required autoComplete="username" placeholder="you@company.com" autoCapitalize="none" spellCheck={false} /></p>
        <p><label htmlFor="password">Password</label><PasswordInput id="password" name="password" required maxLength={256} autoComplete="current-password" /></p>
        <button className="primary login-submit" type="submit">Sign in <span aria-hidden="true">&rarr;</span></button>
        <p className="muted small login-help">Forgot your password? Contact your server administrator.</p>
      </form>
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
      <p className="login-footnote">Aurora CRM <span aria-hidden="true">/</span> DB Media Groups</p>
      </div>
      </section>
    </main>
  );
}
