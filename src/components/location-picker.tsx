"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function LocationPicker({ locations, current }: { locations: { id: string; name: string; city: string | null }[]; current: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  if (locations.length <= 1) return null;
  return (
    <select
      className="input !w-auto"
      value={current ?? ""}
      onChange={(e) => {
        const next = new URLSearchParams(params.toString());
        next.set("location", e.target.value);
        router.push(`${pathname}?${next.toString()}`);
      }}
    >
      {locations.map((l) => (
        <option key={l.id} value={l.id}>
          {l.name}{l.city ? ` · ${l.city}` : ""}
        </option>
      ))}
    </select>
  );
}
