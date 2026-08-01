import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/nav";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = { title: "Jamasp Panel" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <div className="flex min-h-screen">
          <Nav />
          <main className="flex-1 overflow-x-hidden p-6">{children}</main>
        </div>
        <Toaster richColors />
      </body>
    </html>
  );
}
