import NextAuth from "next-auth";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import Resend from "next-auth/providers/resend";
import { db } from "@/db";
import { accounts, sessions, users, verificationTokens } from "@/db/schema";
import { env } from "@/lib/env";
import { sendMail, layout, button } from "@/lib/mail";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "database" },
  pages: { signIn: "/login", verifyRequest: "/login/check-email", error: "/login" },
  providers: [
    Resend({
      from: env.emailFrom,
      apiKey: env.resendKey ?? "dev",
      // Custom sender so local dev works without an API key.
      async sendVerificationRequest({ identifier, url }) {
        await sendMail({
          to: identifier,
          subject: `Sign in to ${env.appName}`,
          text: `Sign in to ${env.appName}: ${url}`,
          html: layout(
            "Your sign-in link",
            `<p>Tap the button to sign in. The link works once and expires in 24 hours.</p>${button(url, "Sign in")}`,
          ),
        });
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      // Only people who already exist (invited) or who have a pending invite may sign in.
      if (!user.email) return false;
      const existing = await db.query.users.findFirst({
        where: (u, { eq }) => eq(u.email, user.email!),
      });
      if (existing) return existing.active;
      const invite = await db.query.invites.findFirst({
        where: (i, { eq, isNull, and }) => and(eq(i.email, user.email!), isNull(i.acceptedAt)),
      });
      return Boolean(invite);
    },
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
});
