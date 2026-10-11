import type { Metadata, Viewport } from "next";
import { Anton, Space_Grotesk } from "next/font/google";
import "./globals.css";

// Google Fonts via next/font: downloaded at build time and self-hosted, so the
// dashboard keeps its typography even if the venue Wi-Fi drops.
const display = Anton({ weight: "400", subsets: ["latin"], variable: "--font-display", display: "swap" });
const body = Space_Grotesk({ subsets: ["latin"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  title: "Shoulder Watch",
  description: "Stalled-vehicle detection on Atlanta's public GDOT traffic cameras, with iMessage alerts.",
};

export const viewport: Viewport = { themeColor: "#050816", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
