import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let ffmpeg: FFmpeg | null = null;

export async function convertToMp3(
  audioBlob: Blob,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
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

  ffmpeg.on("progress", ({ progress }) => {
    if (onProgress) {
      onProgress(Math.round(progress * 100));
    }
  });

  const inputName = "input.wav";
  const outputName = "output.mp3";

  await ffmpeg.writeFile(inputName, await fetchFile(audioBlob));
  await ffmpeg.exec(["-i", inputName, "-b:a", "192k", outputName]);

  const data = (await ffmpeg.readFile(outputName)) as Uint8Array;
  return new Blob([data.buffer as BlobPart], { type: "audio/mp3" });
}

export async function convertToWav(file: File): Promise<Blob> {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length * numberOfChannels * 2;
  const buffer = new ArrayBuffer(44 + length);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + length, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numberOfChannels * 2, true);
  view.setUint16(32, numberOfChannels * 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, length, true);

  // PCM data
  let offset = 44;
  for (let i = 0; i < audioBuffer.length; i++) {
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const sample = Math.max(
        -1,
        Math.min(1, audioBuffer.getChannelData(channel)[i] ?? 1),
      );
      view.setInt16(
        offset,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true,
      );
      offset += 2;
    }
  }

  return new Blob([view], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
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
