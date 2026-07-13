import { fromPromise } from "neverthrow";

export class MediaError extends Error {}

const mediaMap: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

export function getMediaExtension(mimeType: string) {
  return mediaMap[mimeType] ?? mimeType.split("/")[1]?.split(";")[0] ?? "bin";
}

export function getMediaDuration(fileOrUrl: string | File | Blob) {
  return fromPromise(
    new Promise<number>((res, rej) => {
      const audio = new Audio();

      const objectUrl =
        fileOrUrl instanceof File || fileOrUrl instanceof Blob
          ? URL.createObjectURL(fileOrUrl)
          : fileOrUrl;

      audio.addEventListener("loadedmetadata", () => {
        if (fileOrUrl instanceof File || fileOrUrl instanceof Blob) {
          URL.revokeObjectURL(objectUrl);
        }

        res(audio.duration);
      });

      audio.addEventListener("error", () => {
        if (fileOrUrl instanceof File || fileOrUrl instanceof Blob) {
          URL.revokeObjectURL(objectUrl);
        }
        rej(new Error());
      });

      audio.src = objectUrl;
    }),
    () => new MediaError("Failed to get the media duration"),
  );
}
