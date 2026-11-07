import Link from "next/link";
import { signOut } from "@/auth";
import { env } from "@/lib/env";
import type { Viewer } from "@/lib/access";
import { LocationPicker } from "./location-picker";

const nav = [
  { href: "/dashboard", label: "Dashboard", min: "staff" },
  { href: "/orders", label: "Orders", min: "staff" },
  { href: "/me", label: "My shifts", min: "staff" },
  { href: "/schedule", label: "Schedule", min: "shift_lead" },
  { href: "/menu", label: "Menu", min: "shift_lead" },
  { href: "/staff", label: "Staff", min: "manager" },
  { href: "/timesheets", label: "Timesheets", min: "manager" },
  { href: "/inventory", label: "Inventory", min: "shift_lead" },
  { href: "/compliance", label: "Compliance", min: "manager" },
  { href: "/customers", label: "Customers", min: "manager" },
  { href: "/reports", label: "Reports", min: "manager" },
  { href: "/integrations", label: "Integrations", min: "manager" },
  { href: "/locations", label: "Locations", min: "owner" },
  { href: "/brand", label: "Brand", min: "franchisor" },
] as const;

const rank = { staff: 1, shift_lead: 2, manager: 3, owner: 4, franchisor: 5 } as const;

export function Shell({ viewer, locationId, children }: { viewer: Viewer; locationId: string | null; children: React.ReactNode }) {
  const best = Math.max(
    viewer.isFranchisor ? rank.franchisor : 0,
    viewer.isOwner ? rank.owner : 0,
    ...viewer.locations.map((l) => rank[l.role]),
  );
  const q = locationId ? `?location=${locationId}` : "";
  return (
    <div className="flex-1 flex flex-col">
      <header className="bg-white border-b border-[var(--line)]">
        <div className="mx-auto max-w-7xl px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link href="/dashboard" className="font-bold text-[var(--chai)] whitespace-nowrap">{env.appName}</Link>
          <nav className="flex flex-wrap gap-0.5">
            {nav.filter((n) => best >= rank[n.min]).map((n) => (
              <Link key={n.href} href={`${n.href}${n.href === "/brand" || n.href === "/locations" ? "" : q}`} className="px-3 py-1.5 rounded-lg text-sm hover:bg-[#f3eee6] whitespace-nowrap">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <LocationPicker locations={viewer.locations} current={locationId} />
            <span className="text-sm text-[#7a6a5c] hidden sm:inline">{viewer.name ?? viewer.email}</span>
            <form action={async () => { "use server"; await signOut({ redirectTo: "/login" }); }}>
              <button className="btn-secondary btn-sm">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl px-4 py-6 flex-1">{children}</main>
    </div>
  );
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-[#7a6a5c] mt-1">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warn" | "bad" | "info"; children: React.ReactNode }) {
  const cls = {
    neutral: "bg-[#f3eee6] text-[#5b3a1e]",
    good: "bg-green-100 text-green-800",
    warn: "bg-amber-100 text-amber-800",
    bad: "bg-red-100 text-red-800",
    info: "bg-blue-100 text-blue-800",
  }[tone];
  return <span className={`badge ${cls}`}>{children}</span>;
}
