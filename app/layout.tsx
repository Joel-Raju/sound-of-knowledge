import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// §11.4 — "Fonts via `next/font` (Inter for UI, JetBrains Mono for labels/ticker) with
// `display: swap` and system fallbacks".
//
// These were Geist and Geist Mono — the Next.js defaults, not the spec's. They were
// never a deliberate choice; they are what `create-next-app` writes. JetBrains Mono is
// the one that matters visually: §9.9's labels and §11.4's ticker are monospaced so a
// title that is cut off by the pool boundary still reads as a cut-off word.
const inter = Inter({
  variable: "--font-ui",
  subsets: ["latin"],
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "monospace"],
});

const TITLE = "Sound of Knowledge";
const DESCRIPTION =
  "Listen to humanity writing its encyclopedia, live. Every edit to Wikipedia becomes a note and a spark of light.";

/** §14.4 — visible attribution, and the same credit in the link preview. */
const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sound-of-knowledge.example";

export const metadata: Metadata = {
  // Next resolves every *relative* URL in `openGraph`/`twitter` against this, and
  // warns loudly when it is missing — `/og.png` in a `<meta property="og:image">` is
  // not a usable absolute URL for any crawler. Left unset this was silently resolving to
  // `http://localhost:3000` in production.
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: TITLE,
  keywords: ["wikipedia", "generative audio", "live data", "data sonification", "three.js"],
  authors: [{ name: "Sound of Knowledge" }],
  creator: "Sound of Knowledge",
  // §14.2 — no analytics of the user's own; the piece streams public data and keeps
  // nothing. Vercel Analytics is cookieless and aggregate-only, which is why it is here.
  openGraph: {
    type: "website",
    url: SITE,
    siteName: TITLE,
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
  icons: {
    icon: "/icon.svg",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // §11.7 — without this, `env(safe-area-inset-*)` is 0 on every device and the HUD
  // sits under the notch and the home indicator.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} antialiased bg-black overflow-hidden`}
      >
        {children}
        {/* §11.6 — a `<noscript>` message. This piece is a WebGL canvas driven by a
            live audio graph; with scripting off there is literally nothing to render,
            and a blank black page reads as a failed load rather than as a choice. */}
        <noscript>
          <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-neutral-950 px-6 text-center">
            <h1 className="text-lg text-neutral-200">Sound of Knowledge</h1>
            <p className="max-w-md text-sm text-neutral-500">
              This piece draws live Wikipedia edits as sound and light in real time,
              which needs JavaScript to run at all. There is no still version to fall
              back to.
            </p>
          </div>
        </noscript>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
