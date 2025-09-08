import StreamRoom from "@/components/stream-room";

export default async function StreamRoomPage({
  params,
}: PageProps<"/stream/[roomId]">) {
  const { roomId } = await params;

  return (
    <main>
      <StreamRoom roomId={roomId} />
    </main>
  );
}
