import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const description =
  "Operate real phones with a ScreenHand robot arm through human control, REST API, WebSocket video, and MCP.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost ?? requestHeaders.get("host") ?? "127.0.0.1:3012";
  const safeHost = /^[a-zA-Z0-9.:[\]-]+$/.test(requestHost)
    ? requestHost
    : "127.0.0.1:3012";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  const imageUrl = `${protocol}://${safeHost}/og-v3.png`;
  const hostname = safeHost.startsWith("[")
    ? safeHost.slice(0, safeHost.indexOf("]") + 1)
    : safeHost.split(":")[0];
  const isLocal = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(hostname);
  return {
    title: isLocal ? "ScreenHand · Device Platform" : "ScreenHand Developer Docs",
    description,
    openGraph: {
      title: "ScreenHand Developer Platform",
      description,
      type: "website",
      images: [{ url: imageUrl, width: 1731, height: 909, alt: "ScreenHand Developer Platform" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "ScreenHand Developer Platform",
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
