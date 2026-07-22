import { runpodApi } from "@/lib/api-server";
import { isAuthenticated, preloadAuthQuery } from "@/lib/auth-server";
import { api } from "@repo/convex/api";
import { RunPodTTSJob } from "@repo/schemas/runpod";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Header } from "./components/header";
import { TTSForm } from "./components/tts-form";

export const metadata: Metadata = {
  title: "Text-to-Speech | Metamorph",
  description:
    "Generate natural-sounding speech from text using high-fidelity TTS models.",
};

export default async function TTSPage({ searchParams }: PageProps<"/tts">) {
  const authenticated = await isAuthenticated();

  if (!authenticated) {
    redirect("/");
  }
  const [profileQuery, job] = await Promise.all([
    preloadAuthQuery(api.profile.get),
    (async () => {
      const { jobId } = await searchParams;

      const response = await runpodApi.get(
        `/status/${jobId?.toString() ?? ""}`,
        {
          outputSchema: RunPodTTSJob,
        },
      );

      return response.isOk() ? response.value.data : null;
    })(),
  ]);

  return (
    <main className="flex min-h-screen flex-col">
      <Header profileQuery={profileQuery} />
      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 md:px-8">
        <TTSForm job={job} />
      </div>
    </main>
  );
}
