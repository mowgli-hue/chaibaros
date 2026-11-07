import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { requireViewer, pickLocation, canManage } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { CHANNEL_LABEL } from "@/components/channel";
import { db } from "@/db";
import { ingredients, itemLocationSettings, menuCategories } from "@/db/schema";
import { money } from "@/lib/dates";
import { archiveItem, setRecipe, setStoreItem, upsertCategory, upsertItem, upsertModifierGroup } from "@/actions/menu";

const CHANNELS = ["app_thru", "vlink", "tiffingo", "uber_eats", "doordash", "skip"];

export default async function MenuPage({ searchParams }: { searchParams: Promise<{ location?: string; edit?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const active = pickLocation(viewer, sp.location);
  if (!active) redirect("/dashboard");
  const manage = canManage(viewer, active.id);
  const canEditBrand = viewer.brandIds.includes(active.brandId) || (viewer.isOwner && viewer.locations.some((l) => l.brandId === active.brandId));

  const cats = await db.select().from(menuCategories).where(eq(menuCategories.brandId, active.brandId)).orderBy(asc(menuCategories.sortOrder));
  const items = await db.query.menuItems.findMany({
    where: (m, { and, eq }) => and(eq(m.brandId, active.brandId), eq(m.active, true)),
    with: { modifierGroups: { with: { group: { with: { modifiers: true } } } } },
    orderBy: (m, { asc }) => [asc(m.sortOrder), asc(m.name)],
  });
  const groups = await db.query.modifierGroups.findMany({ where: (g, { eq }) => eq(g.brandId, active.brandId), with: { modifiers: true }, orderBy: (g, { asc }) => asc(g.sortOrder) });
  const overrides = await db.select().from(itemLocationSettings).where(eq(itemLocationSettings.locationId, active.id));
  const ov = new Map(overrides.map((o) => [o.itemId, o]));
  const ings = await db.select().from(ingredients).where(and(eq(ingredients.organizationId, active.organizationId), eq(ingredients.active, true))).orderBy(asc(ingredients.name));
  const editing = sp.edit ? items.find((i) => i.id === sp.edit) : undefined;

  return (
    <Shell viewer={viewer} locationId={active.id}>
      <PageTitle title="Menu" subtitle={`Brand menu (${items.length} items) with ${active.name}'s prices and sold-out flags. A sold-out tap here updates App Thru, Vlink and Clover.`} />

      <div className="card overflow-x-auto mb-4">
        <table className="table">
          <thead><tr><th>Item</th><th>Category</th><th>Brand price</th><th>{active.name} price</th><th>Available</th><th>Hidden on</th><th>Modifiers</th><th>Recipe</th>{canEditBrand && <th></th>}</tr></thead>
          <tbody>
            {items.map((i) => {
              const o = ov.get(i.id);
              const available = o ? o.available : true;
              return (
                <tr key={i.id} className={available ? "" : "bg-red-50"}>
                  <td className="font-medium">{i.name}<div className="text-xs text-[#7a6a5c]">{i.sku} · {i.taxClass.replace("_", "+").toUpperCase()} · {i.station}</div></td>
                  <td>{cats.find((c) => c.id === i.categoryId)?.name ?? "—"}</td>
                  <td>{money(i.priceCents)}</td>
                  <td>
                    {manage ? (
                      <form action={setStoreItem} className="flex gap-1"><input type="hidden" name="locationId" value={active.id} /><input type="hidden" name="itemId" value={i.id} /><input type="hidden" name="action" value="price" /><input name="price" type="number" step="0.01" className="input !w-24 !py-1" defaultValue={o?.priceCents != null ? (o.priceCents / 100).toFixed(2) : ""} placeholder="brand" /><button className="btn-secondary btn-sm">Set</button></form>
                    ) : money(o?.priceCents ?? i.priceCents)}
                  </td>
                  <td>
                    <form action={setStoreItem}><input type="hidden" name="locationId" value={active.id} /><input type="hidden" name="itemId" value={i.id} /><input type="hidden" name="action" value="toggle" /><button className={`${available ? "btn-secondary" : "btn-danger"} btn-sm`}>{available ? "Available" : "SOLD OUT"}</button></form>
                  </td>
                  <td>
                    {manage ? (
                      <form action={setStoreItem} className="flex flex-wrap gap-1 items-center text-xs"><input type="hidden" name="locationId" value={active.id} /><input type="hidden" name="itemId" value={i.id} /><input type="hidden" name="action" value="channels" />
                        {CHANNELS.map((c) => <label key={c} className="flex items-center gap-0.5"><input type="checkbox" name="hidden" value={c} defaultChecked={(o?.hiddenChannels ?? []).includes(c)} />{CHANNEL_LABEL[c]}</label>)}
                        <button className="btn-secondary btn-sm">Save</button></form>
                    ) : (o?.hiddenChannels ?? []).map((c) => CHANNEL_LABEL[c]).join(", ")}
                  </td>
                  <td className="text-xs">{i.modifierGroups.map((g) => g.group.name).join(", ") || "—"}</td>
                  <td className="text-xs">{i.recipe.length ? i.recipe.map((r) => `${ings.find((x) => x.id === r.ingredientId)?.name ?? "?"} ×${r.qty}`).join(", ") : <span className="text-[#b5a898]">none</span>}</td>
                  {canEditBrand && <td className="whitespace-nowrap"><a className="btn-secondary btn-sm mr-1" href={`/menu?location=${active.id}&edit=${i.id}`}>Edit</a><form action={archiveItem} className="inline"><input type="hidden" name="brandId" value={active.brandId} /><input type="hidden" name="id" value={i.id} /><button className="btn-secondary btn-sm">Archive</button></form></td>}
                </tr>
              );
            })}
            {items.length === 0 && <tr><td colSpan={9} className="text-[#7a6a5c]">No items yet. Add below or import from Clover under Integrations.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {canEditBrand && (
          <form action={upsertItem} className="card space-y-3">
            <h2 className="font-semibold">{editing ? `Edit ${editing.name}` : "Add item (brand-wide)"}</h2>
            <input type="hidden" name="brandId" value={active.brandId} />
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">SKU</label><input name="sku" className="input" defaultValue={editing?.sku ?? ""} placeholder="CHAI-MASALA" required /></div>
              <div><label className="label">Price $</label><input name="price" type="number" step="0.01" className="input" defaultValue={editing ? (editing.priceCents / 100).toFixed(2) : ""} required /></div>
            </div>
            <div><label className="label">Name</label><input name="name" className="input" defaultValue={editing?.name ?? ""} required /></div>
            <div><label className="label">Description</label><input name="description" className="input" defaultValue={editing?.description ?? ""} /></div>
            <div className="grid grid-cols-3 gap-2">
              <div><label className="label">Category</label><select name="categoryId" className="input" defaultValue={editing?.categoryId ?? ""}><option value="">—</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <div><label className="label">Tax</label><select name="taxClass" className="input" defaultValue={editing?.taxClass ?? "gst_only"}><option value="gst_only">GST only</option><option value="gst_pst">GST + PST</option><option value="exempt">Exempt</option></select></div>
              <div><label className="label">Station</label><select name="station" className="input" defaultValue={editing?.station ?? "bar"}><option value="bar">Bar</option><option value="kitchen">Kitchen</option><option value="packing">Packing</option></select></div>
            </div>
            <div><label className="label">Modifier groups</label><div className="flex flex-wrap gap-2 text-sm">{groups.map((g) => <label key={g.id} className="flex items-center gap-1"><input type="checkbox" name="groupIds" value={g.id} defaultChecked={editing?.modifierGroups.some((x) => x.groupId === g.id)} />{g.name}</label>)}</div></div>
            <div><label className="label">Sort</label><input name="sortOrder" type="number" className="input" defaultValue={editing?.sortOrder ?? 0} /></div>
            <button className="btn-primary w-full">{editing ? "Save" : "Add item"}</button>
            {editing && <a className="btn-secondary w-full" href={`/menu?location=${active.id}`}>Cancel</a>}
          </form>
        )}

        {editing && manage && (
          <form action={setRecipe} className="card space-y-2">
            <h2 className="font-semibold">Recipe · {editing.name}</h2>
            <p className="text-xs text-[#7a6a5c]">Ingredients depleted per unit sold (auto-depletion feeds inventory).</p>
            <input type="hidden" name="brandId" value={active.brandId} /><input type="hidden" name="itemId" value={editing.id} /><input type="hidden" name="locationId" value={active.id} />
            {[0, 1, 2, 3, 4].map((n) => {
              const r = editing.recipe[n];
              return (
                <div key={n} className="flex gap-2">
                  <select name="ingredientId" className="input" defaultValue={r?.ingredientId ?? ""}><option value="">—</option>{ings.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.unit})</option>)}</select>
                  <input name="recipeQty" type="number" step="0.001" className="input !w-24" defaultValue={r?.qty ?? ""} placeholder="qty" />
                </div>
              );
            })}
            <button className="btn-secondary w-full">Save recipe</button>
          </form>
        )}

        {canEditBrand && (
          <div className="space-y-4">
            <form action={upsertCategory} className="card space-y-2">
              <h2 className="font-semibold">Categories</h2>
              <ul className="text-sm">{cats.map((c) => <li key={c.id}>{c.name}</li>)}</ul>
              <input type="hidden" name="brandId" value={active.brandId} />
              <div className="flex gap-2"><input name="name" className="input" placeholder="New category" required /><input name="sortOrder" type="number" className="input !w-20" defaultValue={cats.length} /><button className="btn-secondary">Add</button></div>
            </form>
            <form action={upsertModifierGroup} className="card space-y-2">
              <h2 className="font-semibold">Modifier groups</h2>
              <ul className="text-xs text-[#7a6a5c]">{groups.map((g) => <li key={g.id}><b>{g.name}</b>: {g.modifiers.filter((m) => m.active).map((m) => `${m.name}${m.priceCents ? ` +${money(m.priceCents)}` : ""}`).join(", ")}</li>)}</ul>
              <input type="hidden" name="brandId" value={active.brandId} />
              <input name="name" className="input" placeholder="Group name, e.g. Milk" required />
              <div className="grid grid-cols-2 gap-2"><input name="minSelect" type="number" className="input" defaultValue={0} placeholder="min" /><input name="maxSelect" type="number" className="input" defaultValue={1} placeholder="max" /></div>
              <textarea name="modifiers" className="input" rows={3} placeholder={"One per line: Name=price\nOat milk=0.75\nAlmond=0.75\nLess sugar=0"} />
              <button className="btn-secondary w-full">Add / update group</button>
            </form>
          </div>
        )}
      </div>
      {!canEditBrand && <p className="text-sm text-[#7a6a5c] mt-4">The brand menu is managed by the franchisor. Store managers can set local prices and sold-out flags. <Badge tone="info">read-only</Badge></p>}
    </Shell>
  );
}
