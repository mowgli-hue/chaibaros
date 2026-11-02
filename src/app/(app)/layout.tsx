import { requireViewer } from "@/lib/access";

// Auth gate for every page under (app). Pages render the Shell themselves so
// they can pass the active location.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireViewer();
  return <>{children}</>;
}
