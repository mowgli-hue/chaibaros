import { redirect } from "next/navigation";
import { requireViewer, pickLocation, canManage } from "@/lib/access";
import { Shell, PageTitle, Badge } from "@/components/shell";
import { CHANNEL_LABEL } from "@/components/channel";
import { db } from "@/db";
import { fmtDateTime } from "@/lib/dates";
import { connectClover, createApiClient, disconnectIntegration, revokeApiClient, runCloverImportMenu, runCloverSync } from "@/actions/integrations";
import { env } from "@/lib/env";

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const active = pickLocation(viewer, sp.location);
  if (!active || !canManage(viewer, active.id)) redirect("/dashboard");
  const canApi = viewer.brandIds.includes(active.brandId) || (viewer.isOwner && viewer.locations.some((l) => l.brandId === active.brandId));

  const clover = await db.query.locationIntegrations.findFirst({ where: (l, { and, eq }) => and(eq(l.locationId, active.id), eq(l.provider, "clover")) });
  const clients = canApi ? await db.query.apiClients.findMany({ where: (c, { eq }) => eq(c.brandId, active.brandId), orderBy: (c, { desc }) => desc(c.createdAt) }) : [];
  const deliveries = canApi ? await db.query.webhookDeliveries.findMany({ orderBy: (w, { desc }) => desc(w.createdAt), limit: 15 }) : [];
  const cfg = (clover?.config ?? {}) as Record<string, string>;

  return (
    <Shell viewer={viewer} locationId={active.id}>
      <PageTitle title={`Integrations · ${active.name}`} subtitle="Clover feed for this store, and API credentials for App Thru / Vlink / TiffinGo (brand-wide)." />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-3">
          <div className="flex items-center justify-between"><h2 className="font-semibold">Clover POS</h2>{clover ? <Badge tone={clover.status === "connected" ? "good" : clover.status === "error" ? "bad" : "neutral"}>{clover.status}</Badge> : <Badge>not connected</Badge>}</div>
          <p className="text-xs text-[#7a6a5c]">Clover Dashboard → Setup → API Tokens → create a token with read access to Orders, Inventory, Payments, Customers (write on Inventory to mirror sold-outs). Merchant ID is in the dashboard URL.</p>
          <form action={connectClover} className="space-y-2">
            <input type="hidden" name="locationId" value={active.id} />
            <div><label className="label">Merchant ID</label><input name="merchantId" className="input" defaultValue={cfg.merchantId ?? ""} required /></div>
            <div><label className="label">API token</label><input name="apiToken" type="password" className="input" defaultValue={cfg.apiToken ?? ""} required /></div>
            <div><label className="label">Environment</label><select name="region" className="input" defaultValue={cfg.region ?? "prod"}><option value="prod">Production (api.clover.com)</option><option value="sandbox">Sandbox</option></select></div>
            <button className="btn-primary">Save & test connection</button>
          </form>
          {clover && clover.status !== "disconnected" && (
            <div className="text-sm space-y-2 border-t border-[var(--line)] pt-3">
              {cfg.merchantName && <div>Merchant: <b>{cfg.merchantName}</b></div>}
              <div className="text-xs text-[#7a6a5c]">Last sync: {clover.lastSyncAt ? fmtDateTime(clover.lastSyncAt) : "never"}{clover.lastError && <span className="text-red-700"> · {clover.lastError}</span>}</div>
              <div className="flex flex-wrap gap-2">
                <form action={runCloverImportMenu}><input type="hidden" name="locationId" value={active.id} /><button className="btn-secondary btn-sm">Import menu from Clover</button></form>
                <form action={runCloverSync}><input type="hidden" name="locationId" value={active.id} /><button className="btn-secondary btn-sm">Sync orders now</button></form>
                <form action={disconnectIntegration}><input type="hidden" name="locationId" value={active.id} /><input type="hidden" name="provider" value="clover" /><button className="btn-secondary btn-sm">Disconnect</button></form>
              </div>
              <p className="text-xs text-[#7a6a5c]">Automatic sync: point a cron at <code>{env.appUrl}/api/cron?secret=…</code> every 2–5 minutes (Vercel cron, Railway cron, or GitHub Actions).</p>
            </div>
          )}
        </div>

        <div className="card space-y-3">
          <h2 className="font-semibold">Delivery apps</h2>
          <p className="text-sm text-[#7a6a5c]">Uber Eats, DoorDash and Skip connect two ways: direct Marketplace APIs (partner approval, 6–12 weeks each) or an aggregator bridge (Otter / Deliverect) that posts into <code>POST /api/v1/orders</code> using an API client below with channel set per app. The order model is identical either way.</p>
          <ul className="text-sm space-y-1">
            <li><Badge tone="info">planned</Badge> Uber Eats Marketplace API — application filed by the brand once, every store switches on</li>
            <li><Badge tone="info">planned</Badge> DoorDash Marketplace API</li>
            <li><Badge tone="info">planned</Badge> SkipTheDishes partner API</li>
          </ul>
        </div>

        {canApi && (
          <>
            <form action={createApiClient} className="card space-y-3">
              <h2 className="font-semibold">API clients (App Thru, Vlink, TiffinGo)</h2>
              <input type="hidden" name="brandId" value={active.brandId} />
              <div className="grid grid-cols-2 gap-2">
                <div><label className="label">Name</label><input name="name" className="input" placeholder="App Thru production" required /></div>
                <div><label className="label">Channel</label><select name="channel" className="input"><option value="app_thru">App Thru</option><option value="vlink">Vlink</option><option value="tiffingo">TiffinGo</option><option value="other">Other / aggregator</option></select></div>
              </div>
              <div><label className="label">Webhook URL (order status events)</label><input name="webhookUrl" className="input" placeholder="https://api.appthru.ca/webhooks/chaibar" /></div>
              <div><label className="label">Limit to stores (none = all)</label><div className="flex flex-wrap gap-2 text-sm">{viewer.locations.filter((l) => l.brandId === active.brandId).map((l) => <label key={l.id} className="flex items-center gap-1"><input type="checkbox" name="locationIds" value={l.id} />{l.name}</label>)}</div></div>
              <button className="btn-primary">Create credentials</button>
            </form>
            <div className="card overflow-x-auto">
              <h2 className="font-semibold mb-2">Credentials</h2>
              <table className="table">
                <thead><tr><th>Name</th><th>Channel</th><th>Key ID</th><th>Secret</th><th>Webhook</th><th>Last used</th><th></th></tr></thead>
                <tbody>
                  {clients.map((c) => (
                    <tr key={c.id} className={c.active ? "" : "opacity-50"}>
                      <td>{c.name}</td><td>{CHANNEL_LABEL[c.channel]}</td><td><code className="text-xs">{c.keyId}</code></td>
                      <td><code className="text-xs">{viewer.isOwner || viewer.isFranchisor ? c.secret : `••••${c.secretHint}`}</code></td>
                      <td className="text-xs">{c.webhookUrl ?? "—"}</td><td className="text-xs">{c.lastUsedAt ? fmtDateTime(c.lastUsedAt) : "never"}</td>
                      <td>{c.active && <form action={revokeApiClient}><input type="hidden" name="id" value={c.id} /><button className="btn-secondary btn-sm">Revoke</button></form>}</td>
                    </tr>
                  ))}
                  {clients.length === 0 && <tr><td colSpan={7} className="text-[#7a6a5c]">No API clients yet.</td></tr>}
                </tbody>
              </table>
              <details className="mt-3 text-xs text-[#7a6a5c]"><summary className="cursor-pointer">How App Thru signs a request</summary>
                <pre className="mt-2 whitespace-pre-wrap">{`ts = unix seconds
sig = HMAC_SHA256(secret, ts + "." + rawBody)   // GET: rawBody = ""
headers: X-Api-Key: <keyId>, X-Timestamp: ts, X-Signature: sig
POST ${env.appUrl}/api/v1/orders        (see spec for the body)
GET  ${env.appUrl}/api/v1/menu?location_id=...
GET  ${env.appUrl}/api/v1/orders?location_id=...&since=ISO&status=received,accepted
POST ${env.appUrl}/api/v1/orders/{id}/status   {"status":"ready"}
Webhooks out: X-Chaibar-Signature = HMAC_SHA256(secret, body), events order.received … order.refunded`}</pre>
              </details>
            </div>
            <div className="card overflow-x-auto lg:col-span-2">
              <h2 className="font-semibold mb-2">Recent webhook deliveries</h2>
              <table className="table"><thead><tr><th>When</th><th>Event</th><th>URL</th><th>Attempts</th><th>Status</th></tr></thead>
                <tbody>{deliveries.map((d) => <tr key={d.id}><td className="text-xs">{fmtDateTime(d.createdAt)}</td><td>{d.event}</td><td className="text-xs">{d.url}</td><td>{d.attempts}</td><td>{d.deliveredAt ? <Badge tone="good">delivered</Badge> : <Badge tone="warn">{d.lastError ?? "pending"}</Badge>}</td></tr>)}{deliveries.length === 0 && <tr><td colSpan={5} className="text-[#7a6a5c]">None yet.</td></tr>}</tbody></table>
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}
