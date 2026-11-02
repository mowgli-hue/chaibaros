import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { requireViewer, pickLocation, canManage } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { db } from "@/db";
import { ingredients, stockLevels, stockMovements, suppliers, users } from "@/db/schema";
import { fmtDateTime, money } from "@/lib/dates";
import { archiveIngredient, bulkCount, createIngredient, createSupplier, recordMovement, setPar } from "@/actions/inventory";

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ location?: string; view?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const active = pickLocation(viewer, sp.location);
  if (!active) redirect("/dashboard");
  const manage = canManage(viewer, active.id);
  const view = sp.view === "count" ? "count" : sp.view === "log" ? "log" : "list";

  const rows = await db
    .select({ ing: ingredients, lvl: stockLevels, supplier: suppliers.name })
    .from(ingredients)
    .leftJoin(stockLevels, and(eq(stockLevels.ingredientId, ingredients.id), eq(stockLevels.locationId, active.id)))
    .leftJoin(suppliers, eq(suppliers.id, ingredients.supplierId))
    .where(and(eq(ingredients.organizationId, active.organizationId), eq(ingredients.active, true)))
    .orderBy(ingredients.category, ingredients.name);
  const sups = await db.select().from(suppliers).where(eq(suppliers.organizationId, active.organizationId));
  const log = view === "log"
    ? await db.select({ m: stockMovements, name: ingredients.name, unit: ingredients.unit, who: users.name }).from(stockMovements).innerJoin(ingredients, eq(ingredients.id, stockMovements.ingredientId)).leftJoin(users, eq(users.id, stockMovements.actorId)).where(eq(stockMovements.locationId, active.id)).orderBy(desc(stockMovements.createdAt)).limit(200)
    : [];

  const below = rows.filter((r) => r.lvl && Number(r.lvl.qty) < Number(r.lvl.parLevel));
  const stockValue = rows.reduce((a, r) => a + (r.lvl && r.ing.costCentsPerUnit ? Number(r.lvl.qty) * r.ing.costCentsPerUnit : 0), 0);
  const tab = (v: string, label: string) => <a href={`/inventory?location=${active.id}&view=${v}`} className={`px-3 py-1.5 rounded-lg text-sm ${view === v ? "bg-[var(--chai)] text-white" : "bg-white border border-[var(--line)]"}`}>{label}</a>;

  return (
    <Shell viewer={viewer} locationId={active.id}>
      <PageTitle
        title={`Inventory · ${active.name}`}
        subtitle={`${rows.length} items · ${below.length} below par · stock on hand ≈ ${money(stockValue)}`}
        actions={<div className="flex gap-2">{tab("list", "Stock")}{tab("count", "Weekly count")}{tab("log", "Movements")}</div>}
      />

      {below.length > 0 && view === "list" && (
        <div className="card mb-4 !p-4">
          <h2 className="font-semibold mb-2">Reorder list</h2>
          <ul className="text-sm grid sm:grid-cols-2 lg:grid-cols-3 gap-1">
            {below.map((r) => (
              <li key={r.ing.id}>
                <b>{r.ing.name}</b>: {Number(r.lvl!.qty)} / par {Number(r.lvl!.parLevel)} {r.ing.unit} → order <b>{(Number(r.lvl!.parLevel) - Number(r.lvl!.qty)).toFixed(1)} {r.ing.unit}</b>{r.supplier ? <span className="text-[#7a6a5c]"> · {r.supplier}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view === "count" && (
        <form action={bulkCount} className="card overflow-x-auto mb-4">
          <input type="hidden" name="locationId" value={active.id} />
          <div className="flex items-center justify-between mb-3"><h2 className="font-semibold">Weekly count</h2><button className="btn-primary">Save count</button></div>
          <p className="text-sm text-[#7a6a5c] mb-3">Walk the store, type what you see. Blank = unchanged. Each saved count is logged with your name.</p>
          <table className="table">
            <thead><tr><th>Item</th><th>Unit</th><th>System says</th><th>Counted</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ing.id}><td>{r.ing.name}<div className="text-xs text-[#7a6a5c]">{r.ing.category}</div></td><td>{r.ing.unit}</td><td>{r.lvl ? Number(r.lvl.qty) : 0}</td><td><input name={`count:${r.ing.id}`} type="number" step="0.001" inputMode="decimal" className="input !w-28" /></td></tr>
              ))}
            </tbody>
          </table>
        </form>
      )}

      {view === "log" && (
        <div className="card overflow-x-auto mb-4">
          <table className="table">
            <thead><tr><th>When</th><th>Item</th><th>Kind</th><th>Δ</th><th>Result</th><th>Cost</th><th>Who</th><th>Note</th></tr></thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.m.id}><td className="whitespace-nowrap">{fmtDateTime(l.m.createdAt)}</td><td>{l.name}</td><td><Badge tone={l.m.kind === "waste" ? "bad" : l.m.kind === "receive" ? "good" : "neutral"}>{l.m.kind}</Badge></td><td>{Number(l.m.deltaQty) > 0 ? "+" : ""}{Number(l.m.deltaQty)} {l.unit}</td><td>{Number(l.m.resultingQty)}</td><td>{l.m.costCents != null ? money(l.m.costCents) : ""}</td><td>{l.who}</td><td className="text-[#7a6a5c]">{l.m.note}</td></tr>
              ))}
              {log.length === 0 && <tr><td colSpan={8} className="text-[#7a6a5c]">No movements yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {view === "list" && (
        <div className="card overflow-x-auto mb-4">
          <table className="table">
            <thead><tr><th>Item</th><th>On hand</th><th>Par</th><th>Last count</th><th>Supplier</th><th>Quick action</th>{manage && <th></th>}</tr></thead>
            <tbody>
              {rows.map((r) => {
                const qty = r.lvl ? Number(r.lvl.qty) : 0;
                const par = r.lvl ? Number(r.lvl.parLevel) : 0;
                return (
                  <tr key={r.ing.id} className={qty < par ? "bg-amber-50" : ""}>
                    <td className="font-medium">{r.ing.name}<div className="text-xs text-[#7a6a5c]">{r.ing.category}{r.ing.costCentsPerUnit != null ? ` · ${money(r.ing.costCentsPerUnit)}/${r.ing.unit}` : ""}</div></td>
                    <td>{qty} {r.ing.unit}{qty < par && <Badge tone="warn">low</Badge>}</td>
                    <td>
                      {manage ? (
                        <form action={setPar} className="flex gap-1"><input type="hidden" name="locationId" value={active.id} /><input type="hidden" name="ingredientId" value={r.ing.id} /><input name="par" type="number" step="0.001" className="input !w-20 !py-1" defaultValue={par} /><button className="btn-secondary btn-sm">Set</button></form>
                      ) : par}
                    </td>
                    <td className="text-xs">{r.lvl?.lastCountedAt ? fmtDateTime(r.lvl.lastCountedAt) : "never"}</td>
                    <td>{r.supplier ?? ""}</td>
                    <td>
                      <form action={recordMovement} className="flex gap-1 items-center">
                        <input type="hidden" name="locationId" value={active.id} /><input type="hidden" name="ingredientId" value={r.ing.id} />
                        <select name="kind" className="input !w-auto !py-1"><option value="receive">Receive</option><option value="waste">Waste</option><option value="count">Count</option><option value="adjust">Adjust ±</option></select>
                        <input name="qty" type="number" step="0.001" className="input !w-20 !py-1" placeholder="qty" required />
                        <input name="note" className="input !w-28 !py-1" placeholder="note" />
                        <button className="btn-secondary btn-sm">Log</button>
                      </form>
                    </td>
                    {manage && <td><form action={archiveIngredient}><input type="hidden" name="locationId" value={active.id} /><input type="hidden" name="ingredientId" value={r.ing.id} /><button className="btn-secondary btn-sm">Archive</button></form></td>}
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={7} className="text-[#7a6a5c]">No ingredients yet — add the top 40 below.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {manage && (
        <div className="grid gap-4 lg:grid-cols-2">
          <form action={createIngredient} className="card grid gap-3 sm:grid-cols-2">
            <h2 className="sm:col-span-2 font-semibold">Add ingredient (shared across all your stores)</h2>
            <input type="hidden" name="locationId" value={active.id} />
            <div className="sm:col-span-2"><label className="label">Name</label><input name="name" className="input" placeholder="Whole milk 4L" required /></div>
            <div><label className="label">Category</label><input name="category" className="input" placeholder="Dairy" list="cats" /><datalist id="cats">{[...new Set(rows.map((r) => r.ing.category))].map((c) => <option key={c} value={c} />)}</datalist></div>
            <div><label className="label">Unit</label><select name="unit" className="input">{["ea", "kg", "g", "L", "ml", "bag", "box", "case"].map((u) => <option key={u}>{u}</option>)}</select></div>
            <div><label className="label">Cost per unit $</label><input name="cost" type="number" step="0.01" className="input" /></div>
            <div><label className="label">Par at this store</label><input name="par" type="number" step="0.001" className="input" defaultValue={0} /></div>
            <div className="sm:col-span-2"><label className="label">Supplier</label><select name="supplierId" className="input"><option value="">—</option>{sups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
            <div className="sm:col-span-2"><button className="btn-primary">Add</button></div>
          </form>
          <form action={createSupplier} className="card grid gap-3 sm:grid-cols-2">
            <h2 className="sm:col-span-2 font-semibold">Add supplier</h2>
            <input type="hidden" name="locationId" value={active.id} />
            <div className="sm:col-span-2"><label className="label">Name</label><input name="name" className="input" placeholder="Costco Business Centre / Sysco / local dairy" required /></div>
            <div><label className="label">Contact</label><input name="contact" className="input" /></div>
            <div><label className="label">Phone</label><input name="phone" className="input" /></div>
            <div className="sm:col-span-2"><label className="label">Email</label><input name="email" type="email" className="input" /></div>
            <div className="sm:col-span-2"><button className="btn-secondary">Add supplier</button></div>
          </form>
        </div>
      )}
    </Shell>
  );
}
