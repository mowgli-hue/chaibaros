import { redirect } from "next/navigation";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { requireViewer, pickLocation } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { AutoRefresh } from "@/components/auto-refresh";
import { ChannelBadge } from "@/components/channel";
import { db } from "@/db";
import { itemLocationSettings, menuItems, orders } from "@/db/schema";
import { fmtTime, money } from "@/lib/dates";
import { ORDER_TRANSITIONS } from "@/lib/orders";
import { createManualOrder, markItemDone, setOrderStatus } from "@/actions/orders";

const NEXT_LABEL: Record<string, string> = { accepted: "Accept", preparing: "Start", ready: "Ready", completed: "Done", cancelled: "Cancel", refunded: "Refund" };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ location?: string; view?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const active = pickLocation(viewer, sp.location);
  if (!active) redirect("/dashboard");
  const view = sp.view === "history" ? "history" : "board";
   
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

  const live = await db.query.orders.findMany({
    where: (o, { and, eq, inArray }) => and(eq(o.locationId, active.id), inArray(o.status, ["received", "accepted", "preparing", "ready"])),
    with: { items: true },
    orderBy: (o, { asc }) => asc(o.placedAt),
  });
  const today = view === "history"
    ? await db.query.orders.findMany({ where: (o, { and, eq }) => and(eq(o.locationId, active.id)), with: { items: true }, orderBy: (o, { desc }) => desc(o.placedAt), limit: 150 })
    : await db.query.orders.findMany({ where: (o, { and, eq, gte, inArray }) => and(eq(o.locationId, active.id), gte(o.placedAt, startOfDay), inArray(o.status, ["completed", "cancelled", "refunded"])), with: { items: true }, orderBy: (o, { desc }) => desc(o.placedAt), limit: 40 });
  void and; void asc; void desc; void eq; void gte; void inArray;

  const menu = await db
    .select({ item: menuItems, ov: itemLocationSettings })
    .from(menuItems)
    .leftJoin(itemLocationSettings, and(eq(itemLocationSettings.itemId, menuItems.id), eq(itemLocationSettings.locationId, active.id)))
    .where(and(eq(menuItems.brandId, active.brandId), eq(menuItems.active, true)))
    .orderBy(asc(menuItems.sortOrder), asc(menuItems.name));

  const todaysDone = today.filter((o) => o.status === "completed");
  const todaysGross = todaysDone.reduce((a, o) => a + o.subtotalCents - o.discountCents, 0);
  const cols: Array<[string, string]> = [["received", "New"], ["accepted", "Accepted"], ["preparing", "Preparing"], ["ready", "Ready"]];
  const tab = (v: string, label: string) => <a href={`/orders?location=${active.id}&view=${v}`} className={`px-3 py-1.5 rounded-lg text-sm ${view === v ? "bg-[var(--chai)] text-white" : "bg-white border border-[var(--line)]"}`}>{label}</a>;

  return (
    <Shell viewer={viewer} locationId={active.id}>
      <AutoRefresh seconds={10} />
      <PageTitle
        title={`Orders · ${active.name}`}
        subtitle={`${live.length} live · ${todaysDone.length} completed today · ${money(todaysGross)} net sales today · refreshes every 10s`}
        actions={<div className="flex gap-2">{tab("board", "Board")}{tab("history", "History")}</div>}
      />

      {view === "board" && (
        <div className="grid gap-3 md:grid-cols-4 mb-6">
          {cols.map(([status, label]) => {
            const list = live.filter((o) => o.status === status);
            return (
              <div key={status} className="card !p-3 min-h-40">
                <div className="flex items-center justify-between mb-2"><h2 className="font-semibold text-sm uppercase tracking-wide text-[#7a6a5c]">{label}</h2><span className="text-xs text-[#7a6a5c]">{list.length}</span></div>
                <div className="space-y-2">
                  {list.map((o) => <Ticket key={o.id} o={o} />)}
                  {list.length === 0 && <div className="text-xs text-[#b5a898] py-6 text-center">—</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <form action={createManualOrder} className="card space-y-3">
          <h2 className="font-semibold">Counter order</h2>
          <p className="text-xs text-[#7a6a5c]">Quick entry for walk-ins at stores without Clover, or phone orders. Tax is computed per item.</p>
          <input type="hidden" name="locationId" value={active.id} />
          <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
            {menu.map(({ item, ov }) => {
              const soldOut = ov ? !ov.available : false;
              return (
                <label key={item.id} className={`flex items-center gap-2 text-sm ${soldOut ? "opacity-40" : ""}`}>
                  <input type="hidden" name="sku" value={item.sku} />
                  <input name="qty" type="number" min={0} defaultValue={0} className="input !w-16 !py-1" disabled={soldOut} />
                  <span className="flex-1">{item.name}{soldOut && <Badge tone="bad">sold out</Badge>}</span>
                  <span className="text-[#7a6a5c]">{money(ov?.priceCents ?? item.priceCents)}</span>
                </label>
              );
            })}
            {menu.length === 0 && <p className="text-sm text-[#7a6a5c]">No menu yet — add items under Menu or import from Clover.</p>}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div><label className="label">Tender</label><select name="tender" className="input"><option value="cash">Cash</option><option value="card">Card</option><option value="other">Other</option></select></div>
            <div><label className="label">Tip $</label><input name="tip" type="number" step="0.01" className="input" defaultValue={0} /></div>
            <div><label className="label">Discount $</label><input name="discount" type="number" step="0.01" className="input" defaultValue={0} /></div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><label className="label">Name</label><input name="customerName" className="input" placeholder="optional" /></div>
            <div><label className="label">Phone (loyalty)</label><input name="customerPhone" className="input" placeholder="604…" /></div>
          </div>
          <div><label className="label">Type</label><select name="fulfilment" className="input"><option value="dine_in">Dine in</option><option value="pickup">Takeout</option></select></div>
          <button className="btn-primary w-full">Send to bar / kitchen</button>
        </form>

        <div className="card lg:col-span-2 overflow-x-auto">
          <h2 className="font-semibold mb-3">{view === "history" ? "Recent orders" : "Completed today"}</h2>
          <table className="table">
            <thead><tr><th>#</th><th>Time</th><th>Channel</th><th>Items</th><th>Customer</th><th>Total</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {today.map((o) => (
                <tr key={o.id}>
                  <td className="font-medium">#{o.number}</td>
                  <td className="whitespace-nowrap">{fmtTime(o.placedAt)}{view === "history" && <div className="text-xs text-[#7a6a5c]">{o.placedAt.toLocaleDateString("en-CA")}</div>}</td>
                  <td><ChannelBadge channel={o.channel} /></td>
                  <td className="text-xs">{o.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}</td>
                  <td className="text-xs">{o.customerName ?? ""}{o.customerPhone ? <div className="text-[#7a6a5c]">{o.customerPhone}</div> : null}</td>
                  <td>{money(o.totalCents)}</td>
                  <td><Badge tone={o.status === "completed" ? "good" : o.status === "cancelled" ? "bad" : o.status === "refunded" ? "warn" : "info"}>{o.status}</Badge></td>
                  <td>
                    {o.status === "completed" && (
                      <form action={setOrderStatus} className="flex gap-1"><input type="hidden" name="id" value={o.id} /><input type="hidden" name="status" value="refunded" /><input name="note" className="input !w-28 !py-1" placeholder="reason" required /><button className="btn-secondary btn-sm">Refund</button></form>
                    )}
                  </td>
                </tr>
              ))}
              {today.length === 0 && <tr><td colSpan={8} className="text-[#7a6a5c]">Nothing yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </Shell>
  );
}

function Ticket({ o }: { o: typeof orders.$inferSelect & { items: Array<{ id: string; qty: number; name: string; modifiers: Array<{ name: string; priceCents: number }>; notes: string | null; station: string; doneAt: Date | null }> } }) {
  // eslint-disable-next-line react-hooks/purity
  const ageMin = Math.floor((Date.now() - o.placedAt.getTime()) / 60000);
  const late = ageMin >= 10 ? "border-red-300 bg-red-50" : ageMin >= 5 ? "border-amber-300 bg-amber-50" : "border-[var(--line)] bg-white";
  const nexts = ORDER_TRANSITIONS[o.status].filter((s) => s !== "refunded");
  return (
    <div className={`rounded-lg border p-2 text-sm ${late}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">#{o.number}</span>
        <ChannelBadge channel={o.channel} />
        <span className="text-xs text-[#7a6a5c] ml-auto">{ageMin}m</span>
      </div>
      <div className="text-xs text-[#7a6a5c]">{o.fulfilment.replace("_", " ")}{o.customerName ? ` · ${o.customerName}` : ""}{o.requestedAt ? ` · for ${fmtTime(o.requestedAt)}` : ""}{o.readyBy ? ` · ready by ${fmtTime(o.readyBy)}` : ""}</div>
      <ul className="mt-1 space-y-0.5">
        {o.items.map((i) => (
          <li key={i.id} className="flex items-start gap-1">
            <form action={markItemDone}><input type="hidden" name="itemId" value={i.id} /><button className={`w-4 h-4 rounded border text-[10px] leading-none ${i.doneAt ? "bg-green-600 border-green-600 text-white" : "border-[#b5a898]"}`} title="mark item done">{i.doneAt ? "✓" : ""}</button></form>
            <span className={i.doneAt ? "line-through text-[#7a6a5c]" : ""}><b>{i.qty}×</b> {i.name}{i.modifiers.length ? <span className="text-[#7a6a5c]"> · {i.modifiers.map((m) => m.name).join(", ")}</span> : null}{i.notes ? <span className="text-amber-800"> · {i.notes}</span> : null}</span>
          </li>
        ))}
      </ul>
      {o.notes && <div className="text-xs text-amber-800 mt-1">Note: {o.notes}</div>}
      <div className="flex flex-wrap gap-1 mt-2">
        {nexts.map((s) => (
          <form key={s} action={setOrderStatus} className="flex gap-1 items-center">
            <input type="hidden" name="id" value={o.id} /><input type="hidden" name="status" value={s} />
            {s === "accepted" && <input name="readyMin" type="number" className="input !w-14 !py-0.5 !px-1 !text-xs" defaultValue={10} title="ready in minutes" />}
            {s === "cancelled" && <input name="note" className="input !w-20 !py-0.5 !px-1 !text-xs" placeholder="why" />}
            <button className={`${s === "cancelled" ? "btn-secondary" : "btn-primary"} btn-sm !py-0.5`}>{NEXT_LABEL[s]}</button>
          </form>
        ))}
      </div>
    </div>
  );
}
