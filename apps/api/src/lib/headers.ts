/** Copies string entries from a Node/Effect request header map into a standard `Headers`. */
export function toHeaders(
  rawHeaders: Record<string, string | ReadonlyArray<string> | undefined>,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value === "string") headers.set(key, value);
  }
  return headers;
}
