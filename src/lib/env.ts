export const env = {
  appName: process.env.APP_NAME ?? "Chai Bar OS",
  appUrl: process.env.AUTH_URL ?? "http://localhost:3000",
  emailFrom: process.env.EMAIL_FROM ?? "Chai Bar OS <noreply@example.com>",
  resendKey: process.env.RESEND_API_KEY,
  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM,
  },
};
