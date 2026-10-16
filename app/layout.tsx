import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sound of Knowledge",
  description: "Real-time audiovisual experience of live Wikipedia edits",
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
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-black overflow-hidden`}
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
