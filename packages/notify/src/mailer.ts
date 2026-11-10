export type Mail = { to: string; subject: string; text: string };
export type MailResult = { status: "sent" | "skipped"; id?: string };

/** Transactional email for staff notifications (not prospect outreach, which is Phase 2 with its own sending stack). */
export interface Mailer {
  readonly enabled: boolean;
  send(mail: Mail): Promise<MailResult>;
}

/** Disabled adapter: notifications stay in-app; emails are logged as skipped. */
export class DisabledMailer implements Mailer {
  readonly enabled = false;
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<MailResult> {
    this.sent.push(mail);
    return { status: "skipped" };
  }
}

/** Postmark adapter (transactional stream). Enabled when POSTMARK_SERVER_TOKEN and NOTIFY_FROM_EMAIL are set. */
export class PostmarkMailer implements Mailer {
  readonly enabled = true;
  constructor(private readonly token: string, private readonly from: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async send(mail: Mail): Promise<MailResult> {
    const res = await this.fetchImpl("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-postmark-server-token": this.token },
      body: JSON.stringify({ From: this.from, To: mail.to, Subject: mail.subject, TextBody: mail.text, MessageStream: "outbound" }),
    });
    if (!res.ok) throw new Error(`postmark ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { MessageID?: string };
    return { status: "sent", id: body.MessageID };
  }
}

export function mailerFromEnv(env = process.env): Mailer {
  if (env.POSTMARK_SERVER_TOKEN && env.NOTIFY_FROM_EMAIL) return new PostmarkMailer(env.POSTMARK_SERVER_TOKEN, env.NOTIFY_FROM_EMAIL);
  return new DisabledMailer();
}
