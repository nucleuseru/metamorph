import "client-only";

import { getMediaExtension } from "@/lib/media";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { err, fromAsyncThrowable, ok, safeTry } from "neverthrow";

let ffmpeg: FFmpeg;
let cachedModelBuffer: Uint8Array;

export class FFmpegError extends Error {}

export const getFFmpeg = fromAsyncThrowable(
  async () => {
    ffmpeg ??= new FFmpeg();

    if (!ffmpeg.loaded) {
      const baseURL =
        "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";
      await ffmpeg.load({
        coreURL: await toBlobURL(
          `${baseURL}/ffmpeg-core.js`,
          "text/javascript",
        ),
        wasmURL: await toBlobURL(
          `${baseURL}/ffmpeg-core.wasm`,
          "application/wasm",
        ),
      });
    }

    return ffmpeg;
  },
  () => new FFmpegError("Failed to load FFmpeg"),
);

export function reduceBackgroundNoise(file: File) {
  return safeTry(async function* () {
    const ffmpeg = yield* getFFmpeg();
    const ext = getMediaExtension(file.type);

    const taskId = crypto.randomUUID();
    const inputName = `input_${taskId}.${ext}`;
    const outputName = `output_${taskId}.${ext}`;
    const modelName = `model_${taskId}.rnnn`;

    try {
      await ffmpeg.writeFile(inputName, await file.bytes());

      if (!cachedModelBuffer) {
        const response = await fetch(`/models/bd.rnnn`);
        const modelBuffer = await response.arrayBuffer();
        cachedModelBuffer = new Uint8Array(modelBuffer);
      }

      await ffmpeg.writeFile(modelName, cachedModelBuffer);

      await ffmpeg.exec([
        "-i",
        inputName,
        "-af",
        `arnndn=m=${modelName}`,
        outputName,
      ]);

      const data = await ffmpeg.readFile(outputName);
      const fileOutput = new File([data as BlobPart], file.name, {
        type: file.type,
      });

      return ok(fileOutput);
    } catch {
      return err(
        new FFmpegError(
          `Failed to remove background noise from media of type ${file.type}`,
        ),
      );
    } finally {
      await ffmpeg.deleteFile(modelName).catch(() => void 0);
      await ffmpeg.deleteFile(inputName).catch(() => void 0);
      await ffmpeg.deleteFile(outputName).catch(() => void 0);
    }
  });
}

export function convertMediaToOgg(file: File) {
  return safeTry(async function* () {
    const ffmpeg = yield* getFFmpeg();
    const taskId = crypto.randomUUID();
    const inputName = `input_${taskId}.${getMediaExtension(file.type)}`;
    const outputName = `output_${taskId}.ogg`;

    try {
      await ffmpeg.writeFile(inputName, await file.bytes());

      await ffmpeg.exec(["-i", inputName, "-b:a", "128k", outputName]);

      const data = await ffmpeg.readFile(outputName);
      const fileOutput = new File([data as BlobPart], file.name, {
        type: "audio/ogg; codecs=opus",
      });

      return ok(fileOutput);
    } catch {
      return err(
        new FFmpegError(`Failed to convert media from ${file.type} to ogg`),
      );
    } finally {
      await ffmpeg.deleteFile(inputName).catch(() => void 0);
      await ffmpeg.deleteFile(outputName).catch(() => void 0);
    }
  });
}

export function convertBase64AudioToOgg(
  base64Audio: string,
  inputFormat: string,
) {
  return safeTry(async function* () {
    const ffmpeg = yield* getFFmpeg();
    const taskId = crypto.randomUUID();
    const inputName = `input_${taskId}.${inputFormat}`;
    const outputName = `output_${taskId}.ogg`;

    try {
      const binaryString = atob(base64Audio);
      const bytes = Uint8Array.from(binaryString, (char) => char.charCodeAt(0));

      await ffmpeg.writeFile(inputName, bytes);

      await ffmpeg.exec([
        "-i",
        inputName,
        "-b:a",
        "128k",
        "-c:a",
        "libopus",
        outputName,
      ]);

      const data = await ffmpeg.readFile(outputName);
      const fileOutput = new File([data as BlobPart], "cloned", {
        type: "audio/ogg; codecs=opus",
      });

      return ok(fileOutput);
    } catch {
      return err(
        new FFmpegError(
          `Failed to convert base64 audio from ${inputFormat} to ogg`,
        ),
      );
    } finally {
      await ffmpeg.deleteFile(inputName).catch(() => void 0);
      await ffmpeg.deleteFile(outputName).catch(() => void 0);
    }
  });
}
