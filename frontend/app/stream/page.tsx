import Header from "@/components/header";
import StreamForm from "@/components/stream-form";

export default function StreamPage() {
  return (
    <main className="min-h-dvh grid grid-rows-[auto_1fr]">
      <Header />
      <div className="max-w-6xl mx-auto w-full px-4 py-16 h-full">
        <StreamForm />
      </div>
    </main>
  );
}
