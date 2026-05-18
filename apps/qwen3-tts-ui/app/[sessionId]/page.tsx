import { GetStaticPaths } from "next";
import { VoiceCloningForm } from "../../components/VoiceCloningForm";

export const getStaticPaths = (async () => {
  const sessionIds = ["preboi"];

  return {
    fallback: "blocking",
    paths: sessionIds.map((sessionId) => ({ params: { sessionId } })),
  };
}) satisfies GetStaticPaths;

export default async function Page({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return (
    <main className="min-h-screen bg-black p-8 text-white">
      <VoiceCloningForm sessionId={sessionId} />
    </main>
  );
}
