import axios, {
  AxiosError,
  AxiosRequestConfig,
  AxiosResponse,
  CreateAxiosDefaults,
} from "axios";
import { status } from "http-status";
import { fromPromise } from "neverthrow";
import z from "zod";
import { ERROR_CODE } from "./constants";

type ApiMethodFunc = <T = unknown, R = AxiosResponse<T>, D = unknown>(
  url: string,
  config?: AxiosRequestConfig<D>,
) => Promise<R>;

type ApiDataMethodFunc = <T = unknown, R = AxiosResponse<T>, D = unknown>(
  url: string,
  data?: D,
  config?: AxiosRequestConfig<D>,
) => Promise<R>;

const apiMethod =
  (method: ApiMethodFunc) =>
  <O extends z.ZodType | undefined = undefined, T = z.output<O>>(
    url: string,
    config?: Omit<AxiosRequestConfig, "data"> & { outputSchema?: O },
  ) =>
    fromPromise(
      (async () => {
        const res = await method(url, config);

        if (config?.outputSchema && res.data) {
          res.data = await config.outputSchema.parseAsync(res.data);
        }

        return res as AxiosResponse<T, never>;
      })(),
      (e) =>
        e as
          | AxiosError<T, never>
          | (O extends z.ZodType ? z.ZodError<T> : never),
    );

const apiDataMethod =
  (method: ApiDataMethodFunc) =>
  <
    O extends z.ZodType | undefined = undefined,
    T = z.output<O>,
    I extends z.ZodType | undefined = undefined,
    D = z.output<I>,
  >(
    url: string,
    config?: Omit<AxiosRequestConfig, "data"> & {
      inputSchema?: I;
      outputSchema?: O;
    } & (I extends z.ZodType<infer D> ? { data: D } : { data?: unknown }),
  ) =>
    fromPromise(
      (async () => {
        if (config?.inputSchema && config.data) {
          config.data = await config.inputSchema.parseAsync(config.data);
        }

        const res = await method(url, config?.data, config);

        if (config?.outputSchema && res.data) {
          res.data = await config.outputSchema.parseAsync(res.data);
        }

        return res as AxiosResponse<T, D>;
      })(),
      (e) =>
        e as
          | AxiosError<T, D>
          | (O extends z.ZodType ? z.ZodError<T> : never)
          | (I extends z.ZodType ? z.ZodError<D> : never),
    );

export function createApi<T>(config?: CreateAxiosDefaults<T>) {
  const api = axios.create(config);

  return {
    ...api,
    get: apiMethod(api.get.bind(api)),
    delete: apiMethod(api.delete.bind(api)),
    head: apiMethod(api.head.bind(api)),
    options: apiMethod(api.options.bind(api)),
    post: apiDataMethod(api.post.bind(api)),
    put: apiDataMethod(api.put.bind(api)),
    patch: apiDataMethod(api.patch.bind(api)),
    postForm: apiDataMethod(api.postForm.bind(api)),
    putForm: apiDataMethod(api.putForm.bind(api)),
    patchForm: apiDataMethod(api.patchForm.bind(api)),
    query: apiDataMethod(api.query.bind(api)),
  };
}

export function handleAxiosError(error: AxiosError) {
  switch (error.status ?? error.code) {
    case status.BAD_REQUEST:
      return ERROR_CODE.BAD_REQUEST;
    case status.UNAUTHORIZED:
      return ERROR_CODE.UNAUTHORIZED;
    case status.FORBIDDEN:
      return ERROR_CODE.FORBIDDEN;
    case status.NOT_FOUND:
      return ERROR_CODE.NOT_FOUND;
    case status.CONFLICT:
      return ERROR_CODE.CONFLICT;
    case status.TOO_MANY_REQUESTS:
      return ERROR_CODE.TOO_MANY_REQUESTS;
    case status.INTERNAL_SERVER_ERROR:
      return ERROR_CODE.INTERNAL_SERVER_ERROR;
    case status.SERVICE_UNAVAILABLE:
      return ERROR_CODE.SERVICE_UNAVAILABLE;
    case AxiosError.ECONNABORTED:
      return ERROR_CODE.REQUEST_ABORTED;
    case AxiosError.ERR_NETWORK:
      return ERROR_CODE.NETWORK;
    case AxiosError.ETIMEDOUT:
      return ERROR_CODE.TIMEOUT;
    default:
      return ERROR_CODE.UNKNOWN;
  }
}
