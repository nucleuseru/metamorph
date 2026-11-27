import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001",
});

export function getAppOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}
