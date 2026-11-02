import { Resend } from "resend";
import { env } from "./env";

type Mail = { to: string; subject: string; html: string; text?: string };

/**
 * Sends email through Resend. With no RESEND_API_KEY set (local dev) the
 * message is printed to the server console so magic links still work.
 */
export async function sendMail(mail: Mail) {
  if (!env.resendKey || env.resendKey.startsWith("re_xxx")) {
    console.log("\n[mail:dev] to=%s subject=%s\n%s\n", mail.to, mail.subject, mail.text ?? mail.html);
    return { id: "dev" };
  }
  const resend = new Resend(env.resendKey);
  const { data, error } = await resend.emails.send({
    from: env.emailFrom,
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (error) throw new Error(`Resend: ${error.message}`);
  return data;
}

export function layout(title: string, body: string) {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f3ee;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e8e2d9">
    <div style="font-weight:700;font-size:18px;color:#5b3a1e;margin-bottom:12px">${env.appName}</div>
    <h1 style="font-size:20px;margin:0 0 12px">${title}</h1>
    <div style="font-size:15px;line-height:1.5;color:#333">${body}</div>
  </div></body></html>`;
}

export function button(href: string, label: string) {
  return `<p style="margin:20px 0"><a href="${href}" style="background:#5b3a1e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;display:inline-block">${label}</a></p>
  <p style="font-size:12px;color:#777">Or paste this link: ${href}</p>`;
}
