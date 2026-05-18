import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let ffmpeg: FFmpeg | null = null;

async function getFFmpeg() {
  ffmpeg ??= new FFmpeg();

  if (!ffmpeg.loaded) {
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(
        `${baseURL}/ffmpeg-core.wasm`,
        "application/wasm",
      ),
    });
  }

  return ffmpeg;
}

export type AudioFormat = "mp3" | "ogg";

export async function convertAudio(
  audioBlob: Blob,
  format: AudioFormat,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();

  ffmpeg.off("progress", () => void 0);
  ffmpeg.on("progress", ({ progress }) => {
    if (onProgress) {
      onProgress(Math.round(progress * 100));
    }
  });

  const inputName = "input.wav";
  const outputName = `output.${format}`;

  await ffmpeg.writeFile(inputName, await fetchFile(audioBlob));

  const args = ["-i", inputName];

  if (format === "mp3") {
    args.push("-b:a", "192k", outputName);
  } else {
    args.push("-b:a", "128k", "-c:a", "libopus", outputName);
  }

  await ffmpeg.exec(args);

  const data = (await ffmpeg.readFile(outputName)) as Uint8Array;
  const mimeType = format === "mp3" ? "audio/mp3" : "audio/ogg";
  return new Blob([data.buffer as BlobPart], { type: mimeType });
}

export async function convertToWav(file: File): Promise<Blob> {
  const ffmpeg = await getFFmpeg();

  const inputName = file.name;
  const outputName = "output.wav";

  await ffmpeg.writeFile(inputName, await fetchFile(file));
  await ffmpeg.exec(["-i", inputName, "-ar", "44100", "-ac", "1", outputName]);

  const data = (await ffmpeg.readFile(outputName)) as Uint8Array;
  return new Blob([data.buffer as BlobPart], { type: "audio/wav" });
}

export async function fetchWithProgress(
  url: string,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  let response: Response | null = null;
  for (let i = 0; i < 3; i++) {
    try {
      response = await fetch(url);
      if (response.ok) break;
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (!response?.ok) throw new Error("Failed to fetch");

  const contentLength = Number(response.headers.get("Content-Length") ?? 0);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("ReadableStream not supported");

  const chunks: BlobPart[] = [];
  let receivedLength = 0;

  while (true as boolean) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedLength += value.length;
    if (contentLength && onProgress) {
      onProgress(Math.round((receivedLength / contentLength) * 100));
    }
  }

  return new Blob(chunks);
}

export function triggerFileDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
