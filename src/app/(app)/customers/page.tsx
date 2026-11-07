import { desc, eq, ilike, or, and } from "drizzle-orm";
import { requireViewer, pickLocation } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { fmtDate, money } from "@/lib/dates";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ location?: string; q?: string; sort?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const active = pickLocation(viewer, sp.location);
  const brandIds = [...new Set(viewer.locations.map((l) => l.brandId))];
  if (!active) return null;
  const q = sp.q?.trim();
  const rows = await db
    .select()
    .from(customers)
    .where(and(eq(customers.brandId, active.brandId), q ? or(ilike(customers.name, `%${q}%`), ilike(customers.phone, `%${q}%`), ilike(customers.email, `%${q}%`)) : undefined))
    .orderBy(sp.sort === "visits" ? desc(customers.visits) : sp.sort === "recent" ? desc(customers.lastSeenAt) : desc(customers.lifetimeCents))
    .limit(300);
  void brandIds;
  // eslint-disable-next-line react-hooks/purity
  const lapsedCut = Date.now() - 30 * 24 * 3600 * 1000;
  return (
    <Shell viewer={viewer} locationId={active.id}>
      <PageTitle title="Customers" subtitle={`${rows.length} shown · one record per phone across every channel and store in the brand. Marketing engine (Phase 4) builds on these consents.`}
        actions={<form className="flex gap-2"><input name="q" className="input" placeholder="name, phone, email" defaultValue={q ?? ""} /><select name="sort" className="input !w-auto" defaultValue={sp.sort ?? "ltv"}><option value="ltv">Top spend</option><option value="visits">Most visits</option><option value="recent">Most recent</option></select><button className="btn-secondary">Search</button></form>} />
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Customer</th><th>Visits</th><th>Lifetime</th><th>Avg</th><th>First seen</th><th>Last seen</th><th>Consent</th><th>Sources</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="font-medium">{c.name ?? "—"}<div className="text-xs text-[#7a6a5c]">{c.phone}{c.email ? ` · ${c.email}` : ""}</div></td>
                <td>{c.visits}</td><td>{money(c.lifetimeCents)}</td><td>{money(c.visits ? Math.round(c.lifetimeCents / c.visits) : 0)}</td>
                <td className="text-xs">{fmtDate(c.firstSeenAt)}</td>
                <td className="text-xs">{fmtDate(c.lastSeenAt)}{c.lastSeenAt.getTime() < lapsedCut && c.visits > 1 && <Badge tone="warn">lapsed</Badge>}</td>
                <td>{c.marketingConsent ? <Badge tone="good">yes · {c.consentSource}</Badge> : <Badge>no</Badge>}</td>
                <td className="text-xs">{Object.keys(c.externalIds).join(", ")}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="text-[#7a6a5c]">No customers yet — they appear as orders come in with a phone or email.</td></tr>}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
