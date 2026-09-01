import type { Metadata } from "next";
import { Inter, Vazirmatn } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/nav";
import { Toaster } from "@/components/ui/sonner";
import { THEME_STORAGE_KEY } from "@/lib/theme";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const vazirmatn = Vazirmatn({ subsets: ["arabic"], variable: "--font-fa", display: "swap" });

export const metadata: Metadata = { title: "Jamasp Panel" };

/**
 * Runs before first paint, so the correct appearance is on <html> before
 * anything is drawn. Mirrors lib/theme.ts#resolveAppearance; kept to three
 * statements deliberately, because it cannot import and must not drift.
 * The try/catch covers private browsing, where the storage accessor throws.
 */
const THEME_SCRIPT = `(function(){try{
var p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
if(p!=="light"&&p!=="dark"&&p!=="system")p="system";
var d=p==="dark"||(p==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.classList.add(d?"dark":"light");
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${vazirmatn.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {/* Replaced by <AppShell> in Task 11. */}
        <div className="flex min-h-screen">
          <Nav />
          <main className="flex-1 overflow-x-hidden p-6">{children}</main>
        </div>
        <Toaster richColors />
      </body>
    </html>
  );
}
