import "client-only";

import { getMediaExtension } from "@/lib/media";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { err, fromAsyncThrowable, ok, safeTry } from "neverthrow";
import z from "zod";
import { api } from "./api-client";

let ffmpeg: FFmpeg | null = null;
let rnnnModel: Uint8Array | null = null;

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

export function getRNNNModel() {
  return safeTry(async function* () {
    if (!rnnnModel) {
      const response = yield* api.get("/models/bd.rnnn", {
        responseType: "arraybuffer",
        outputSchema: z.instanceof(ArrayBuffer),
      });
      rnnnModel = new Uint8Array(response.data);
    }

    return ok(rnnnModel);
  });
}

export function processVoiceInput(file: File) {
  return safeTry(async function* () {
    const ffmpeg = yield* getFFmpeg();
    const model = yield* getRNNNModel();

    const taskId = crypto.randomUUID();
    const ext = getMediaExtension(file.type);
    const modelName = `model_${taskId}.rnnn`;
    const inputName = `input_${taskId}.${ext}`;
    const outputName = `output_${taskId}.ogg`;

    try {
      await Promise.all([
        ffmpeg.writeFile(modelName, model),
        ffmpeg.writeFile(inputName, await file.bytes()),
      ]);

      await ffmpeg.exec([
        "-i",
        inputName,
        "-af",
        `arnndn=m=${modelName}`,
        "-ac",
        "1",
        "-b:a",
        "128k",
        outputName,
      ]);

      const data = await ffmpeg.readFile(outputName);
      const fileOutput = new File([data as BlobPart], file.name, {
        type: "audio/ogg; codecs=opus",
      });

      return ok(fileOutput);
    } catch {
      return err(
        new FFmpegError("Encountered an error while processing voice input"),
      );
    } finally {
      await Promise.all([
        ffmpeg.deleteFile(modelName),
        ffmpeg.deleteFile(inputName),
        ffmpeg.deleteFile(outputName),
      ]).catch(() => void 0);
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
      await Promise.all([
        ffmpeg.deleteFile(inputName),
        ffmpeg.deleteFile(outputName),
      ]).catch(() => void 0);
    }
  });
}
