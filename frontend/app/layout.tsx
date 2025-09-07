import "./globals.css";

import Header from "@/components/header";
import { Toaster } from "@/components/ui/sonner";
import type { Metadata } from "next";
import { Inter } from "next/font/google";

const interSans = Inter({
  variable: "--font-inter-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Metamorph",
    template: "%s | Metamorph",
  },
  description:
    "Metamorph lets you easily change faces and voices during live video calls.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className={`${interSans.variable} antialiased`}>
        <main className="min-h-dvh grid grid-rows-[auto_1fr]">
          <Header />
          {children}
        </main>
        <Toaster />
      </body>
    </html>
  );
}
