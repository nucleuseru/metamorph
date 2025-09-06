import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

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
      <body className={`${interSans.variable} antialiased`}>{children}</body>
    </html>
  );
}
