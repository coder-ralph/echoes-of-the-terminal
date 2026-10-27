import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource/im-fell-english/400.css";
import "@fontsource/im-fell-english/400-italic.css";
import "@fontsource/vt323/400.css";
import "@xterm/xterm/css/xterm.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Echoes of the Terminal",
  description:
    "A haunted shell that answers back. An open-weight model running on your own machine whispers about the commands you type. No cloud, no API keys.",
  authors: [{ name: "Ralph Rosael" }],
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.jpg",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0603",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="amber">
      <body>{children}</body>
    </html>
  );
}
