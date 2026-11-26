import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import "./globals.css";
import { Providers } from "@/components/providers";
import { cn } from "@/lib/utils";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Metamorph",
  description: "Transform your look and voice live on camera.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#111113",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={cn("dark h-full antialiased", inter.variable, jetbrainsMono.variable)}
    >
      <body
        cz-shortcut-listen="true"
        className="flex min-h-full flex-col bg-background font-sans font-medium text-foreground"
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
