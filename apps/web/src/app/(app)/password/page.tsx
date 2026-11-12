import { PageHeading } from "@/components/PageHeading";
import { PasswordInput } from "@/components/PasswordInput";

export default async function Password({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return <>
    <PageHeading title="Change password" eyebrow="ACCOUNT SECURITY" description="Update your password and sign out all existing sessions." />
    <section className="card settings-form">
    {error && <p role="alert" className="error">Password change failed. Check your current password and confirmation, then retry.</p>}
    <form action="/auth/local/password" method="post">
      <p><label htmlFor="current-password">Current password</label><PasswordInput id="current-password" name="currentPassword" autoComplete="current-password" required maxLength={256} /></p>
      <p><label htmlFor="new-password">New password (at least 12 characters)</label><PasswordInput id="new-password" name="password" autoComplete="new-password" required minLength={12} maxLength={256} /></p>
      <p><label htmlFor="confirm-password">Confirm new password</label><PasswordInput id="confirm-password" name="confirmation" autoComplete="new-password" required minLength={12} maxLength={256} /></p>
      <button className="primary" type="submit">Change password and sign out all sessions</button>
    </form>
  </section></>;
}
