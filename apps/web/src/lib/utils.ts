import { AxiosError } from "axios";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import z from "zod";
import { handleAxiosError } from "./axios";
import { ERROR_CODE } from "./constants";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function globalHandleError(error: unknown): string {
  if (error instanceof AxiosError) return handleAxiosError(error);
  if (error instanceof z.ZodError) return ERROR_CODE.BAD_REQUEST;
  if (typeof error === "string") return error;
  return ERROR_CODE.UNKNOWN;
}

export const ok = <T>(data: T) => ({ success: true as const, data });

export const err = (error: unknown) => ({
  success: false as const,
  error: globalHandleError(error),
});
