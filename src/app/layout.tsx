import type { Metadata } from "next";
import { Toaster } from "sonner";
import { LINK_PREVIEW_DESCRIPTION } from "@/lib/site-metadata";
import "./globals.css";

const metadataBaseUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(metadataBaseUrl),
  title: "ParkSwap",
  description: LINK_PREVIEW_DESCRIPTION,
  openGraph: {
    title: "ParkSwap",
    description: LINK_PREVIEW_DESCRIPTION,
    siteName: "ParkSwap",
    locale: "en_US",
    type: "website",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "ParkSwap",
    description: LINK_PREVIEW_DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster position="bottom-right" richColors theme="light" />
      </body>
    </html>
  );
}
