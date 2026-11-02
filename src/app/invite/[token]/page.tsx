import { auth, signIn } from "@/auth";
import { db } from "@/db";
import { acceptInvite } from "@/actions/staff";
import { env } from "@/lib/env";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await db.query.invites.findFirst({ where: (i, { eq }) => eq(i.token, token) });
  const session = await auth();

  if (!invite) return <Shell title="Invite not found">Ask your manager to send a new one.</Shell>;
  if (invite.acceptedAt) return <Shell title="Already accepted"><a className="btn-primary" href="/me">Open my shifts</a></Shell>;
  if (invite.expiresAt < new Date()) return <Shell title="Invite expired">Ask your manager to resend it.</Shell>;

  const signedInAsInvitee = session?.user?.email?.toLowerCase() === invite.email;

  return (
    <Shell title={`Join ${env.appName}`}>
      <p className="mb-4">
        {invite.name ? `Hi ${invite.name}, ` : ""}you've been invited as <b>{invite.role.replace("_", " ")}</b>.
      </p>
      {signedInAsInvitee ? (
        <form action={async () => { "use server"; await acceptInvite(token); }}>
          <button className="btn-primary w-full">Accept and continue</button>
        </form>
      ) : (
        <form
          action={async () => {
            "use server";
            await signIn("resend", { email: invite.email, redirectTo: `/invite/${token}` });
          }}
        >
          <p className="text-sm text-[#7a6a5c] mb-3">We'll email a sign-in link to <b>{invite.email}</b>.</p>
          <button className="btn-primary w-full">Email me a sign-in link</button>
        </form>
      )}
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="card w-full max-w-sm">
        <div className="text-[var(--chai)] font-bold text-lg mb-1">{env.appName}</div>
        <h1 className="text-xl font-semibold mb-3">{title}</h1>
        <div className="text-sm">{children}</div>
      </div>
    </main>
  );
}
