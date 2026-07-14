import { ConvexClientProvider } from "@/components/convex-client-provider";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Metamorph",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={cn(
        "h-full",
        "antialiased",
        "font-mono",
        jetbrainsMono.variable,
      )}
    >
      <ConvexClientProvider>
        <body className="flex min-h-full flex-col">
          <NuqsAdapter>{children}</NuqsAdapter>
          <Toaster />
        </body>
      </ConvexClientProvider>
    </html>
  );
}
