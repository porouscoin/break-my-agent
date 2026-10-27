import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

const description = "A prompt-injection CTF. Get Ava, an AI agent with real tools, to leak a secret through five layers of defenses.";

export const metadata: Metadata = {
  metadataBase: new URL("https://break-my-agent-ctf.vercel.app"),
  title: "Break my agent",
  description,
  applicationName: "Break my agent",
  openGraph: { title: "Break my agent", description, type: "website", siteName: "Break my agent" },
  twitter: { card: "summary_large_image", title: "Break my agent", description },
};

export const viewport: Viewport = {
  themeColor: "#08090a",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
