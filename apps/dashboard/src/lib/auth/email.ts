import 'server-only';
import nodemailer, { type Transporter } from 'nodemailer';

let _transporter: Transporter | null = null;
let _transporterMode: 'smtp' | 'log' = 'log';

function getTransporter(): Transporter {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && port) {
    _transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user && pass ? { user, pass } : undefined,
    });
    _transporterMode = 'smtp';
    return _transporter;
  }

  // Dev fallback: log to stdout so devs can grab the link from `docker logs`.
  _transporter = nodemailer.createTransport({
    jsonTransport: true,
  });
  _transporterMode = 'log';
  return _transporter;
}

function getFrom(): string {
  return process.env.SMTP_FROM ?? 'Sutura <noreply@sutura.local>';
}

function getAppUrl(): string {
  return process.env.APP_URL ?? 'http://localhost:3000';
}

export function buildInviteAcceptUrl(token: string): string {
  return `${getAppUrl()}/invite/accept?token=${encodeURIComponent(token)}`;
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const link = `${getAppUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const subject = 'Reset your Sutura password';
  const text =
    `Hi,\n\nWe received a request to reset your Sutura password.\n` +
    `If you made this request, click the link below within 1 hour:\n\n${link}\n\n` +
    `If not, you can ignore this email.\n`;

  await sendMail({ to, subject, text });
}

export async function sendInvitationEmail(
  to: string,
  token: string,
  orgName: string,
  inviterEmail: string,
): Promise<void> {
  const link = buildInviteAcceptUrl(token);
  const subject = `${inviterEmail} invited you to ${orgName} on Sutura`;
  const text =
    `Hi,\n\n${inviterEmail} invited you to join ${orgName} on Sutura.\n` +
    `Accept the invitation within 7 days:\n\n${link}\n`;

  await sendMail({ to, subject, text });
}

async function sendMail(opts: { to: string; subject: string; text: string }): Promise<void> {
  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from: getFrom(),
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
  });
  if (_transporterMode === 'log') {
    console.warn(`[email] (dev) ${opts.to} :: ${opts.subject}\n${opts.text}\n`);
  } else {
    console.warn(`[email] sent ${info.messageId} to ${opts.to}`);
  }
}
