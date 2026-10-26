import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Break my agent",
  description: "A prompt-injection game: get Ava, an AI agent with real tools, to leak a secret through 5 layers of defenses.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
