import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const CONVEX_SITE_URL = process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? "";
    const RUNPOD_WEBHOOK_SECRET = process.env.RUNPOD_WEBHOOK_SECRET ?? "";

    if (!CONVEX_SITE_URL || !RUNPOD_WEBHOOK_SECRET) {
      return new NextResponse(null, { status: 500 });
    }

    const requestUrl = new URL(request.url);
    const type = requestUrl.searchParams.get("type");
    const userId = requestUrl.searchParams.get("userId");
    const nextUrl = new URL(
      `/webhook/runpod${requestUrl.search}`,
      CONVEX_SITE_URL,
    ).toString();

    const headers = new Headers(request.headers);

    headers.delete("transfer-encoding");
    headers.delete("content-length");
    headers.delete("connection");
    headers.set("content-type", "application/json");
    headers.set("authorization", `Bearer ${RUNPOD_WEBHOOK_SECRET}`);

    const data: unknown = await request.json().catch(() => null);

    const init: RequestInit = {
      headers,
      method: request.method,
      body: JSON.stringify({
        type,
        userId,
        ...(typeof data === "object" && data !== null ? data : {}),
      }),
    };

    const response = await fetch(nextUrl, init);

    return new NextResponse(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch {
    return new NextResponse(null, { status: 500 });
  }
}
