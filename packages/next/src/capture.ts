import { createHash } from "node:crypto";
import { cookies } from "next/headers.js";
import { NextResponse } from "next/server.js";

export const COMMISH_COOKIE = "commish_attribution";

export function createAttributionHandler(options: {
  apiUrl?: string;
  secretKey?: string;
}): (request: Request) => Promise<Response> {
  return async function POST(request: Request) {
    const body = await request.text();
    const captureId = request.headers.get("x-commish-capture-id");
    if (!captureId || !/^[a-f\d]{32}$/.test(captureId))
      return NextResponse.json(
        {
          error: {
            code: "invalid_capture_id",
            message: "A valid browser capture ID is required.",
          },
        },
        { status: 400 },
      );
    const apiUrl = (options.apiUrl ?? "https://app.commish.sh/api/v1").replace(
      /\/+$/,
      "",
    );
    const clientIp = request.headers.get("x-vercel-forwarded-for");
    const userAgent = request.headers.get("user-agent");
    const country = request.headers.get("x-vercel-ip-country");
    const previousAttributionId = (await cookies()).get(COMMISH_COOKIE)?.value;
    let idempotencyBody = body;
    let forwardedBody = body;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const { previousAttributionId: _untrusted, ...capture } =
          parsed as Record<string, unknown>;
        void _untrusted;
        idempotencyBody = JSON.stringify(capture);
        forwardedBody = JSON.stringify({
          ...capture,
          ...(previousAttributionId &&
          /^atr_[A-Za-z0-9_-]{12,}$/.test(previousAttributionId)
            ? { previousAttributionId }
            : {}),
        });
      }
    } catch {
      // Preserve malformed input for the API contract to reject consistently.
    }
    const idempotencyKey = `attribution:${createHash("sha256")
      .update(`${captureId}.${idempotencyBody}`)
      .digest("hex")}`;
    const response = await fetch(`${apiUrl}/attributions/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-commish-publishable-key":
          request.headers.get("x-commish-publishable-key") ?? "",
        ...(options.secretKey
          ? { authorization: `Bearer ${options.secretKey}` }
          : {}),
        ...(clientIp ? { "x-commish-client-ip": clientIp } : {}),
        ...(userAgent ? { "user-agent": userAgent } : {}),
        ...(country ? { "x-vercel-ip-country": country } : {}),
      },
      body: forwardedBody,
    });
    const responseText = await response.text();
    let payload: unknown;
    try {
      payload = responseText ? JSON.parse(responseText) : undefined;
    } catch {
      payload = undefined;
    }
    if (!response.ok)
      return NextResponse.json(
        payload && typeof payload === "object"
          ? payload
          : {
              error: {
                code: "attribution_capture_failed",
                message: "Attribution capture failed.",
              },
            },
        { status: response.status },
      );
    const capturePayload =
      payload && typeof payload === "object"
        ? (payload as { data?: { token?: unknown; expiresAt?: unknown } })
        : undefined;
    const token = capturePayload?.data?.token;
    const expiresAt = capturePayload?.data?.expiresAt;
    const expiresAtMs =
      typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    const maxAge = Math.floor((expiresAtMs - Date.now()) / 1000);
    if (
      typeof token !== "string" || !token || typeof expiresAt !== "string" ||
      !Number.isFinite(expiresAtMs) || maxAge <= 0
    )
      return NextResponse.json(
        {
          error: {
            code: "invalid_capture_response",
            message: "Commish returned an invalid attribution response.",
          },
        },
        { status: 502 },
      );
    const outgoing = NextResponse.json(
      { data: { captured: true, expiresAt } },
      { status: response.status },
    );
    outgoing.cookies.set(COMMISH_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(expiresAtMs),
      maxAge,
    });
    return outgoing;
  };
}
