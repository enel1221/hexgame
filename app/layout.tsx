import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    metadataBase: new URL(origin),
    title: {
      default: "Hex Dominion",
      template: "%s · Hex Dominion",
    },
    description:
      "Command a living procedural realm in a tactical territory RTS built for the browser.",
    applicationName: "Hex Dominion",
    keywords: ["strategy game", "hex game", "browser RTS", "procedural map", "multiplayer"],
    icons: {
      icon: "/og.png",
      shortcut: "/og.png",
    },
    openGraph: {
      type: "website",
      url: origin,
      title: "Hex Dominion",
      description:
        "Territory bends to the bold. Expand, fortify, and conquer a living procedural hex realm.",
      images: [
        {
          url: `${origin}/og.png`,
          width: 1731,
          height: 909,
          alt: "Hex Dominion tabletop battlefield",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Hex Dominion",
      description: "Territory bends to the bold.",
      images: [`${origin}/og.png`],
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
