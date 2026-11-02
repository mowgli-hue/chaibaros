import { signIn } from "@/auth";
import { env } from "@/lib/env";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; callbackUrl?: string }> }) {
  const { error, callbackUrl } = await searchParams;
  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="card w-full max-w-sm">
        <div className="text-[var(--chai)] font-bold text-lg mb-1">{env.appName}</div>
        <h1 className="text-xl font-semibold mb-4">Sign in</h1>
        <p className="text-sm text-[#7a6a5c] mb-4">
          Enter your work email. We email you a one-tap sign-in link — no password.
        </p>
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm p-3">
            {error === "AccessDenied"
              ? "That email has not been invited yet. Ask your manager or owner for an invite."
              : "Sign-in failed. Try again."}
          </div>
        )}
        <form
          action={async (formData) => {
            "use server";
            await signIn("resend", {
              email: String(formData.get("email")).trim().toLowerCase(),
              redirectTo: callbackUrl ?? "/dashboard",
            });
          }}
          className="space-y-3"
        >
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" name="email" type="email" required className="input" placeholder="you@thechaibar.ca" />
          </div>
          <button className="btn-primary w-full" type="submit">Email me a sign-in link</button>
        </form>
      </div>
    </main>
  );
}
