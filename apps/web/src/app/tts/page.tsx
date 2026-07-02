import type { Metadata } from "next";
import { Header } from "./components/header";
import { TTSForm } from "./components/tts-form";

export const metadata: Metadata = {
  title: "Text-to-Speech | Metamorph",
  description:
    "Generate natural-sounding speech from text using high-fidelity TTS models.",
};

export default function TTSPage() {
  return (
    <main className="min-h-screen bg-zinc-50 flex flex-col">
      <Header />
      <div className="flex-1 w-full max-w-7xl mx-auto px-4 py-8 md:px-8">
        <TTSForm />
      </div>
    </main>
  );
}
