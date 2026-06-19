import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Rolling Correlations",
  description: "Correlaciones rolling entre portafolios Ken French y tickers Yahoo Finance",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={inter.variable}>
      <body className="bg-surface text-ink antialiased font-sans">{children}</body>
    </html>
  );
}
