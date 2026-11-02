import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/db";
import { bootstrap } from "@/actions/onboarding";
import { env } from "@/lib/env";

export default async function Onboarding() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const existing = await db.query.memberships.findFirst({ where: (m, { eq }) => eq(m.userId, session.user!.id!) });
  if (existing) redirect("/dashboard");

  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="card w-full max-w-lg">
        <div className="text-[var(--chai)] font-bold text-lg mb-1">{env.appName}</div>
        <h1 className="text-xl font-semibold mb-1">Set up your brand</h1>
        <p className="text-sm text-[#7a6a5c] mb-5">
          One-time setup. You become the owner of the first franchisee organization; tick the box if you also run the brand (franchisor view).
        </p>
        <form action={bootstrap} className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">Brand</label>
            <input name="brandName" className="input" defaultValue="The Chai Bar" required />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Your franchisee organization (legal or trade name)</label>
            <input name="orgName" className="input" placeholder="e.g. 1523025 B.C. Ltd." required />
          </div>
          <div className="sm:col-span-2">
            <label className="label">First store</label>
            <input name="locationName" className="input" placeholder="e.g. King George Blvd" required />
          </div>
          <div>
            <label className="label">City</label>
            <input name="city" className="input" defaultValue="Surrey" required />
          </div>
          <div>
            <label className="label">Province</label>
            <input name="province" className="input" defaultValue="BC" maxLength={2} required />
          </div>
          <label className="sm:col-span-2 flex items-center gap-2 text-sm">
            <input type="checkbox" name="iAmFranchisor" /> I am also the franchisor (see every franchisee and store)
          </label>
          <div className="sm:col-span-2">
            <button className="btn-primary w-full" type="submit">Create</button>
          </div>
        </form>
      </div>
    </main>
  );
}
