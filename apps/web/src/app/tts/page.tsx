import { isAuthenticated } from "@/lib/auth-server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Header } from "./components/header";
import { TTSForm } from "./components/tts-form";

export const metadata: Metadata = {
  title: "Text-to-Speech | Metamorph",
  description:
    "Generate natural-sounding speech from text using high-fidelity TTS models.",
};

export default async function TTSPage() {
  const authenticated = await isAuthenticated();

  if (!authenticated) {
    redirect("/");
  }

  return (
    <main className="flex min-h-screen flex-col bg-zinc-50">
      <Header />
      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 md:px-8">
        <TTSForm />
      </div>
    </main>
  );
}
