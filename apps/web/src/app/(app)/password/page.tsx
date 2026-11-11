export default async function Password({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return <section className="card">
    <h1>Change password</h1>
    {error && <p role="alert" className="error">Password change failed. Check your current password and confirmation, then retry.</p>}
    <form action="/auth/local/password" method="post">
      <p><label>Current password<br /><input name="currentPassword" type="password" autoComplete="current-password" required maxLength={256} /></label></p>
      <p><label>New password (at least 12 characters)<br /><input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} /></label></p>
      <p><label>Confirm new password<br /><input name="confirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={256} /></label></p>
      <button type="submit">Change password and sign out all sessions</button>
    </form>
  </section>;
}
