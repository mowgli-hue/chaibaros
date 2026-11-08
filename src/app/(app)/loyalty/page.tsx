import { redirect } from "next/navigation";
import { desc, eq, sql } from "drizzle-orm";
import { requireViewer, pickLocation } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { CHANNEL_LABEL } from "@/components/channel";
import { db } from "@/db";
import { customers, loyaltyAccounts, loyaltyLedger, promotions } from "@/db/schema";
import { fmtDateTime, money } from "@/lib/dates";
import { getProgram } from "@/lib/loyalty";
import { manualPoints, saveProgram, togglePromo, upsertPromo } from "@/actions/loyalty";

const CH = ["counter", "clover", "app_thru", "vlink", "tiffingo", "uber_eats", "doordash", "skip"];

export default async function LoyaltyPage({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const active = pickLocation(viewer, sp.location);
  if (!active) redirect("/dashboard");
  const brandId = active.brandId;
  const admin = viewer.brandIds.includes(brandId) || (viewer.isOwner && viewer.locations.some((l) => l.brandId === brandId));
  if (!admin) redirect("/dashboard");
  const program = await getProgram(brandId);
  const promos = await db.select().from(promotions).where(eq(promotions.brandId, brandId)).orderBy(desc(promotions.createdAt));
  const top = await db.select({ a: loyaltyAccounts, c: customers }).from(loyaltyAccounts).innerJoin(customers, eq(customers.id, loyaltyAccounts.customerId)).where(eq(loyaltyAccounts.brandId, brandId)).orderBy(desc(loyaltyAccounts.balance)).limit(15);
  const recent = await db.select({ l: loyaltyLedger, c: customers }).from(loyaltyLedger).innerJoin(customers, eq(customers.id, loyaltyLedger.customerId)).where(eq(customers.brandId, brandId)).orderBy(desc(loyaltyLedger.createdAt)).limit(20);
  const members = await db.$count(loyaltyAccounts, eq(loyaltyAccounts.brandId, brandId));
  const [outstanding] = await db.select({ s: sql<string>`coalesce(sum(${loyaltyAccounts.balance}), 0)::text` }).from(loyaltyAccounts).where(eq(loyaltyAccounts.brandId, brandId));

  return (
    <Shell viewer={viewer} locationId={active.id}>
      <PageTitle title={`Loyalty & promos · ${program.name}`} subtitle={`${members} members · ${Number(outstanding?.s ?? 0).toLocaleString()} points outstanding ≈ ${money(Number(outstanding?.s ?? 0) * program.redeemCentsPerPoint)} liability`} />
      <div className="grid gap-4 lg:grid-cols-3">
        <form action={saveProgram} className="card space-y-3">
          <h2 className="font-semibold">Program rules</h2>
          <input type="hidden" name="brandId" value={brandId} />
          <div><label className="label">Name</label><input name="name" className="input" defaultValue={program.name} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={program.active} /> Active</label>
          <div className="grid grid-cols-2 gap-2">
            <div><label className="label">Points per $1 net</label><input name="pointsPerDollar" type="number" className="input" defaultValue={program.pointsPerDollar} /></div>
            <div><label className="label">Cents per point</label><input name="redeemCentsPerPoint" type="number" className="input" defaultValue={program.redeemCentsPerPoint} /></div>
            <div><label className="label">Min points to redeem</label><input name="minRedeemPoints" type="number" className="input" defaultValue={program.minRedeemPoints} /></div>
            <div><label className="label">Max % of order</label><input name="maxRedeemPctOfOrder" type="number" className="input" defaultValue={program.maxRedeemPctOfOrder} /></div>
            <div><label className="label">Signup bonus</label><input name="signupBonusPoints" type="number" className="input" defaultValue={program.signupBonusPoints} /></div>
            <div><label className="label">Birthday bonus</label><input name="birthdayBonusPoints" type="number" className="input" defaultValue={program.birthdayBonusPoints} /></div>
          </div>
          <div><label className="label">Earn on channels</label><div className="flex flex-wrap gap-2 text-sm">{CH.map((c) => <label key={c} className="flex items-center gap-1"><input type="checkbox" name="earnOnChannels" value={c} defaultChecked={program.earnOnChannels.includes(c)} />{CHANNEL_LABEL[c]}</label>)}</div></div>
          <p className="text-xs text-[#7a6a5c]">Example: {program.pointsPerDollar} pts/$ and {program.redeemCentsPerPoint}¢/pt = {((program.pointsPerDollar * program.redeemCentsPerPoint) / 100 * 100).toFixed(1)}% back. Aggregator orders are usually excluded.</p>
          <button className="btn-primary w-full">Save</button>
        </form>

        <form action={upsertPromo} className="card space-y-3">
          <h2 className="font-semibold">New promo code</h2>
          <input type="hidden" name="brandId" value={brandId} />
          <div className="grid grid-cols-2 gap-2">
            <div><label className="label">Code</label><input name="code" className="input" placeholder="FIRSTCHAI" required /></div>
            <div><label className="label">Name</label><input name="name" className="input" placeholder="First App Thru order" required /></div>
            <div><label className="label">Type</label><select name="kind" className="input"><option value="percent">% off</option><option value="amount">$ off</option><option value="free_item">Free item</option></select></div>
            <div><label className="label">Value (% or $)</label><input name="value" type="number" step="0.01" className="input" defaultValue={10} /></div>
            <div><label className="label">Free item SKU</label><input name="freeItemSku" className="input" placeholder="CHAI-MASALA" /></div>
            <div><label className="label">Min subtotal $</label><input name="minSubtotal" type="number" step="0.01" className="input" defaultValue={0} /></div>
            <div><label className="label">Starts</label><input name="startsAt" type="date" className="input" /></div>
            <div><label className="label">Ends</label><input name="endsAt" type="date" className="input" /></div>
            <div><label className="label">Max redemptions</label><input name="maxRedemptions" type="number" className="input" placeholder="∞" /></div>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="firstOrderOnly" /> First order only</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="oncePerCustomer" defaultChecked /> Once per customer</label>
          <div><label className="label">Channels (none = all)</label><div className="flex flex-wrap gap-2 text-sm">{CH.map((c) => <label key={c} className="flex items-center gap-1"><input type="checkbox" name="channels" value={c} />{CHANNEL_LABEL[c]}</label>)}</div></div>
          <div><label className="label">Stores (none = all)</label><div className="flex flex-wrap gap-2 text-sm">{viewer.locations.filter((l) => l.brandId === brandId).map((l) => <label key={l.id} className="flex items-center gap-1"><input type="checkbox" name="locationIds" value={l.id} />{l.name}</label>)}</div></div>
          <button className="btn-primary w-full">Create code</button>
        </form>

        <div className="card overflow-x-auto">
          <h2 className="font-semibold mb-2">Codes</h2>
          <table className="table"><thead><tr><th>Code</th><th>Rule</th><th>Used</th><th></th></tr></thead>
            <tbody>{promos.map((p) => <tr key={p.id} className={p.active ? "" : "opacity-50"}><td><b>{p.code}</b><div className="text-xs text-[#7a6a5c]">{p.name}</div></td><td className="text-xs">{p.kind === "percent" ? `${p.value}% off` : p.kind === "amount" ? `${money(p.value)} off` : `free ${p.freeItemSku}`}{p.minSubtotalCents ? ` · min ${money(p.minSubtotalCents)}` : ""}{p.firstOrderOnly ? " · 1st order" : ""}{p.channels.length ? ` · ${p.channels.map((c) => CHANNEL_LABEL[c]).join("/")}` : ""}{p.endsAt ? ` · ends ${p.endsAt.toLocaleDateString("en-CA")}` : ""}</td><td>{p.redemptions}{p.maxRedemptions ? `/${p.maxRedemptions}` : ""}</td><td><form action={togglePromo}><input type="hidden" name="id" value={p.id} /><button className="btn-secondary btn-sm">{p.active ? "Pause" : "Enable"}</button></form></td></tr>)}{promos.length === 0 && <tr><td colSpan={4} className="text-[#7a6a5c]">No codes yet.</td></tr>}</tbody></table>
        </div>

        <div className="card overflow-x-auto lg:col-span-2">
          <h2 className="font-semibold mb-2">Top balances</h2>
          <table className="table"><thead><tr><th>Customer</th><th>Tier</th><th>Balance</th><th>Earned</th><th>Redeemed</th><th>Adjust</th></tr></thead>
            <tbody>{top.map(({ a, c }) => <tr key={a.customerId}><td>{c.name ?? c.phone}<div className="text-xs text-[#7a6a5c]">{c.phone} · {c.visits} visits</div></td><td><Badge tone={a.tier === "vip" ? "good" : a.tier === "regular" ? "info" : "neutral"}>{a.tier}</Badge></td><td className="font-medium">{a.balance.toLocaleString()} <span className="text-xs text-[#7a6a5c]">≈ {money(a.balance * program.redeemCentsPerPoint)}</span></td><td>{a.lifetimeEarned.toLocaleString()}</td><td>{a.lifetimeRedeemed.toLocaleString()}</td>
              <td><form action={manualPoints} className="flex gap-1"><input type="hidden" name="customerId" value={a.customerId} /><input type="hidden" name="brandId" value={brandId} /><input name="delta" type="number" className="input !w-20 !py-1" placeholder="±pts" required /><input name="note" className="input !w-28 !py-1" placeholder="reason" required /><button className="btn-secondary btn-sm">Apply</button></form></td></tr>)}</tbody></table>
        </div>

        <div className="card overflow-x-auto">
          <h2 className="font-semibold mb-2">Recent activity</h2>
          <table className="table"><tbody>{recent.map(({ l, c }) => <tr key={l.id}><td className="text-xs">{fmtDateTime(l.createdAt)}</td><td className="text-xs">{c.name ?? c.phone}</td><td className="text-xs">{l.kind}</td><td className={l.delta >= 0 ? "text-green-700" : "text-red-700"}>{l.delta >= 0 ? "+" : ""}{l.delta}</td></tr>)}</tbody></table>
        </div>
      </div>
    </Shell>
  );
}
