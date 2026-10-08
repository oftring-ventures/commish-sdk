import { cookies } from "next/headers.js";
import { COMMISH_COOKIE } from "./capture.js";
import type { CreatorPageOptions, PageOptionsSource } from "./pages-routing.js";
export const COMMISH_PAGE_VISIT_COOKIE = "commish_page_visit";
const VISITOR_COOKIE = "commish_page_visitor";
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
/** Call in the authenticated checkout handler after reading current CMP consent. */
export async function withCommishPageMeasurement<
  T extends {
    mode?: string;
    metadata?: Record<string, string | number | null>;
    subscription_data?: {
      metadata?: Record<string, string | number | null>;
      [key: string]: unknown;
    };
  },
>(params: T, measurementAllowed: boolean): Promise<T> {
  const { commish_page_visit: _untrusted, ...metadata } = params.metadata ?? {};
  void _untrusted;
  const token = measurementAllowed
    ? (await cookies()).get(COMMISH_PAGE_VISIT_COOKIE)?.value
    : undefined;
  const reference =
    token?.startsWith("cpv_") && uuid.test(token.slice(4))
      ? { commish_page_visit: token }
      : {};
  const {
    commish_page_visit: _subscriptionUntrusted,
    ...subscriptionMetadata
  } = params.subscription_data?.metadata ?? {};
  void _subscriptionUntrusted;
  return {
    ...params,
    metadata: { ...metadata, ...reference },
    ...(params.mode === "subscription"
      ? {
          subscription_data: {
            ...params.subscription_data,
            metadata: { ...subscriptionMetadata, ...reference },
          },
        }
      : {}),
  };
}
export type CreatorPageHandlerOptions = {
  options: PageOptionsSource;
  publishableKey: string | (() => string);
  /** Read your CMP's authoritative same-origin consent. Default: both denied. */
  consent?: (
    request: Request,
  ) =>
    | { attribution: boolean; measurement: boolean }
    | Promise<{ attribution: boolean; measurement: boolean }>;
};
async function upstream(
  options: CreatorPageOptions,
  path: string,
  input: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(
    `${(options.apiUrl ?? "https://app.commish.sh/api/v1").replace(/\/$/, "")}${path}`,
    {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
      headers: {
        authorization: `Bearer ${options.secretKey}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) throw new Error("page_integration_unavailable");
  const value = await response.json();
  return value?.data as Record<string, unknown> | undefined;
}

/** Call from your consent-update server handler when measurement is withdrawn.
 * Retry recorded:false; the anonymous visitor cookie is retained only to retry
 * the revocation, while checkout measurement is cleared immediately.
 */
export async function withdrawCreatorPageMeasurement(
  source: PageOptionsSource,
): Promise<{ recorded: boolean }> {
  const jar = await cookies(),
    visitorId = jar.get(VISITOR_COOKIE)?.value;
  jar.delete(COMMISH_PAGE_VISIT_COOKIE);
  if (!visitorId || !uuid.test(visitorId)) {
    jar.delete(VISITOR_COOKIE);
    return { recorded: true };
  }
  try {
    const options = typeof source === "function" ? await source() : source;
    const receipt = await upstream(options, "/pages/measurement/withdraw", {
      visitorId,
    });
    if (receipt?.recorded === true) {
      jar.delete(VISITOR_COOKIE);
      return { recorded: true };
    }
  } catch {
    /* The merchant can retry revocation without reporting success. */
  }
  return { recorded: false };
}

export function createCreatorPageHandlers(
  configuration: CreatorPageHandlerOptions,
) {
  return {
    POST: async (request: Request): Promise<Response> => {
      const { NextResponse } = await import("next/server.js");
      const headers = { "cache-control": "private, no-store" };
      const json = (data: unknown, status = 200) =>
        NextResponse.json({ data }, { status, headers });
      let options: CreatorPageOptions;
      try {
        options =
          typeof configuration.options === "function"
            ? await configuration.options()
            : configuration.options;
      } catch {
        return json(null, 503);
      }
      if (request.method !== "POST") return json(null, 405);
      // Next may see an internal HTTP URL behind HTTPS termination. Bind CSRF
      // to the configured public origin, never to spoofable forwarded headers.
      if (
        request.headers.get("origin") !== options.origin ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        return json(null, 403);
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return json(null, 415);
      // Limit the actual stream, not just attacker-provided Content-Length.
      let raw = "";
      if (!request.body) return json(null, 400);
      const reader = request.body.getReader(),
        decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
          if (raw.length > 4096) {
            await reader.cancel();
            return json(null, 413);
          }
        }
        raw += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        return json(null, 400);
      }
      if (
        !input ||
        !["identify", "start", "exposure", "click"].includes(input.action) ||
        typeof input.handle !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{2,39}$/.test(input.handle) ||
        typeof input.captureId !== "string" ||
        !uuid.test(input.captureId) ||
        typeof input.revision !== "string" ||
        !uuid.test(input.revision)
      )
        return json(null, 400);
      const consent = (await configuration.consent?.(request)) ?? {
        attribution: false,
        measurement: false,
      };
      const jar = await cookies();
      const path = `/pages/${options.programId}/${input.handle}`;
      const cookie = {
        httpOnly: true,
        sameSite: "lax" as const,
        secure: true,
        path: "/",
      };
      if (input.action === "identify") {
        const response = json({ identified: consent.measurement });
        // Establish the cookie before allocating any visits. A later consent
        // withdrawal can therefore fence every identity used by in-flight starts.
        const current = jar.get(VISITOR_COOKIE)?.value;
        if (consent.measurement && (!current || !uuid.test(current)))
          response.cookies.set(VISITOR_COOKIE, crypto.randomUUID(), {
            ...cookie,
            maxAge: 60 * 60 * 24 * 30,
          });
        return response;
      }
      if (input.action !== "start") {
        if (
          !consent.measurement ||
          typeof input.visitToken !== "string" ||
          input.visitToken.length > 2048
        )
          return json({ recorded: false });
        try {
          return json(
            await upstream(options, `${path}/events`, {
              event: input.action,
              visitToken: input.visitToken,
            }),
          );
        } catch {
          return json({ recorded: false }, 503);
        }
      }
      let capture: Record<string, unknown> | undefined,
        visit: Record<string, unknown> | undefined;
      const captureWork = (async () => {
        if (consent.attribution)
          try {
            capture = await upstream(
              options,
              `${path}/capture`,
              {
                requestId: input.captureId,
                // A malformed cookie must not make the server reject capture.
                previousAttributionId: /^atr_[A-Za-z0-9_-]{12,}$/.test(
                  jar.get(COMMISH_COOKIE)?.value ?? "",
                )
                  ? jar.get(COMMISH_COOKIE)?.value
                  : undefined,
              },
              {
                "x-commish-publishable-key":
                  typeof configuration.publishableKey === "function"
                    ? configuration.publishableKey()
                    : configuration.publishableKey,
                "idempotency-key": `page:${input.captureId}`,
                // Only Vercel's canonical IP header is forwarded; ordinary X-Forwarded-For isn't trusted.
                ...(request.headers.get("x-vercel-forwarded-for")
                  ? {
                      "x-commish-client-ip": request.headers.get(
                        "x-vercel-forwarded-for",
                      )!,
                    }
                  : {}),
                "user-agent": request.headers.get("user-agent") ?? "",
              },
            );
          } catch {
            /* A bounded failure must not prevent shopping or claim capture. */
          }
      })();
      const visitor = jar.get(VISITOR_COOKIE)?.value;
      const visitorId = visitor && uuid.test(visitor) ? visitor : undefined;
      const measurementReady = input.measurementReady === true;
      const visitWork = (async () => {
        if (visitorId && (measurementReady || !consent.measurement))
          try {
            visit = await upstream(options, `${path}/visits`, {
              requestId: input.captureId,
              visitorId,
              revision: input.revision,
              measurementAllowed: consent.measurement && measurementReady,
            });
          } catch {
            /* Standard layout is the fail-safe. */
          }
      })();
      await Promise.all([captureWork, visitWork]);
      const expires =
        typeof capture?.expiresAt === "string"
          ? Date.parse(capture.expiresAt)
          : NaN;
      const captured =
        typeof capture?.token === "string" &&
        /^atr_[A-Za-z0-9_-]{12,}$/.test(capture.token) &&
        expires > Date.now();
      const visitToken =
        typeof visit?.visitToken === "string" && visit.visitToken.length <= 2048
          ? visit.visitToken
          : undefined;
      const response = json({
        captured,
        retryable:
          (consent.attribution && !captured) ||
          (consent.measurement && measurementReady && !visitToken),
        variation: visit?.variation === "alternate" ? "alternate" : "standard",
        visitToken,
      });
      if (captured)
        response.cookies.set(COMMISH_COOKIE, capture!.token as string, {
          ...cookie,
          expires: new Date(expires),
        });
      if (consent.measurement && visitToken && visitorId) {
        response.cookies.set(VISITOR_COOKIE, visitorId, {
          ...cookie,
          maxAge: 60 * 60 * 24 * 30,
        });
        response.cookies.set(COMMISH_PAGE_VISIT_COOKIE, visitToken, {
          ...cookie,
          maxAge: 60 * 60 * 24 * 30,
        });
      } else if (!consent.measurement || visit?.withdrawn === true) {
        response.cookies.set(COMMISH_PAGE_VISIT_COOKIE, "", {
          ...cookie,
          maxAge: 0,
        });
        if (visit?.variation === "standard" || !visitor)
          response.cookies.set(VISITOR_COOKIE, "", { ...cookie, maxAge: 0 });
      }
      return response;
    },
  };
}
