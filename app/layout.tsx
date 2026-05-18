import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rolling Correlations",
  description: "Correlaciones rolling entre portafolios Ken French y tickers Yahoo Finance",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="bg-white text-zinc-900 antialiased">{children}</body>
    </html>
  );
}
