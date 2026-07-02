import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import axios, {
  AxiosRequestConfig,
  AxiosResponse,
  CreateAxiosDefaults,
} from "axios";
import { clsx, type ClassValue } from "clsx";
import { Result } from "neverthrow";
import { twMerge } from "tailwind-merge";
import z from "zod";

let ffmpeg: FFmpeg | null = null;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export async function getFFmpeg() {
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

export function handleApiError(error: unknown) {
  let message = "An unknown error occurred";

  if (axios.isAxiosError(error)) {
    message = error.message;
  } else if (error instanceof z.ZodError) {
    message = z.prettifyError(error);
  }

  return message;
}

export function done<T, E>(result: Result<T, E>) {
  if (result.isErr()) {
    return { success: false as const, error: result.error };
  }

  return { success: true as const, data: result.value };
}

export function createTypedApi<T>(config?: CreateAxiosDefaults<T>) {
  type CustomMethodFunc = <T = unknown, R = AxiosResponse<T>, D = unknown>(
    url: string,
    config?: AxiosRequestConfig<D>,
  ) => Promise<R>;

  type CustomDataMethodFunc = <T = unknown, R = AxiosResponse<T>, D = unknown>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ) => Promise<R>;

  interface AppAxiosRequestConfig<
    T,
    D = unknown,
  > extends AxiosRequestConfig<D> {
    input?: z.ZodType<D>;
    output?: z.ZodType<T>;
  }

  function customMethod(method: CustomMethodFunc) {
    return async function <T, D>(
      url: string,
      config?: AppAxiosRequestConfig<T, D>,
    ) {
      const response = await method<T, AxiosResponse<T, D>, D>(url, config);

      if (config?.output && response.data) {
        response.data = await config.output.parseAsync(response.data);
      }

      return response;
    };
  }

  function customDataMethod(method: CustomDataMethodFunc) {
    return async function <T, D>(
      url: string,
      data?: D,
      config?: AppAxiosRequestConfig<T, D>,
    ) {
      if (config?.input && data) {
        data = await config.input.parseAsync(data);
      }

      const response = await method<T, AxiosResponse<T, D>, D>(
        url,
        data,
        config,
      );

      if (config?.output && response.data) {
        response.data = await config.output.parseAsync(response.data);
      }

      return response;
    };
  }

  const api = axios.create(config);

  return {
    ...api,
    get: customMethod(api.get),
    delete: customMethod(api.delete),
    head: customMethod(api.head),
    options: customMethod(api.options),
    post: customDataMethod(api.post),
    put: customDataMethod(api.put),
    patch: customDataMethod(api.patch),
    postForm: customDataMethod(api.postForm),
    putForm: customDataMethod(api.putForm),
    patchForm: customDataMethod(api.patchForm),
    query: customDataMethod(api.query),
  };
}
