import { VoiceCloningForm } from "@/components/voice-cloning-form";
import { notFound } from "next/navigation";

const sessionIds = ["preboi", "magic-clone", "nucleus", "messiahson"];

export async function generateStaticParams() {
  return sessionIds.map((sessionId) => ({ sessionId }));
}

export default async function Page({ params }: PageProps<"/[sessionId]">) {
  const { sessionId } = await params;

  if (!sessionIds.includes(sessionId)) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-black p-8 text-white">
      <VoiceCloningForm sessionId={sessionId} />
    </main>
  );
}
