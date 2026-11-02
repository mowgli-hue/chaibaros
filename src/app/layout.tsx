import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chai Bar OS",
  description: "Franchise operations: staff, scheduling, inventory, compliance",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
