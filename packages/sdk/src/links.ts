/**
 * Referral links on the business's own domain (https://brand.com/c/maya).
 * The business's server asks Commish where to send the buyer and forwards them
 * there; the existing `commish_ref` capture does the rest.
 */
export type LinkPauseReason = "funding_paused" | "promotion";
export type LinkHandoff =
  | { protocol: "commish-links-v1"; status: "ready"; location: string }
  | { protocol: "commish-links-v1"; status: "paused"; reason: LinkPauseReason }
  /** A route check sent by Commish. Answer it with an empty 204. */
  | { protocol: "commish-links-v1"; status: "probe" };
export type LinkRouteCheck = {
  verified: boolean;
  /** The route creators are shown now; null while none is verified. */
  route: { origin: string; prefix: string; template: string } | null;
};

const HANDLE = /^[a-z0-9][a-z0-9_-]{2,39}$/;
const PREFIX = /^\/[a-z][a-z0-9-]{0,29}$/;

export function linkHandle(value: string): string {
  if (typeof value !== "string" || !HANDLE.test(value))
    throw new TypeError("Invalid creator link handle");
  return value;
}

export function linkPrefix(value: string): string {
  if (typeof value !== "string" || !PREFIX.test(value)) throw new TypeError("Invalid link prefix");
  return value;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const httpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};

/** Validate the redirect boundary even when a merchant supplies a custom transport. */
export function assertLinkHandoff(value: unknown): asserts value is LinkHandoff {
  const invalid = () => {
    throw new TypeError("Unsupported or invalid Commish link response");
  };
  if (!object(value) || value.protocol !== "commish-links-v1") return invalid();
  const keys = Object.keys(value).sort().join();
  if (value.status === "ready") {
    if (keys !== "location,protocol,status" || !httpsUrl(value.location)) invalid();
  } else if (value.status === "paused") {
    if (
      keys !== "protocol,reason,status" ||
      !["funding_paused", "promotion"].includes(value.reason as string)
    )
      invalid();
  } else if (value.status !== "probe" || keys !== "protocol,status") invalid();
}

export function assertLinkRouteCheck(value: unknown): asserts value is LinkRouteCheck {
  const route = object(value) ? value.route : undefined;
  if (
    !object(value) ||
    typeof value.verified !== "boolean" ||
    !(
      route === null ||
      (object(route) &&
        httpsUrl(route.origin) &&
        new URL(route.origin).origin === route.origin &&
        typeof route.prefix === "string" &&
        PREFIX.test(route.prefix) &&
        typeof route.template === "string")
    )
  )
    throw new TypeError("Unsupported or invalid Commish link route response");
}

const pauseCopy: Record<LinkPauseReason, { title: string; body: string }> = {
  promotion: {
    title: "Promotion is temporarily unavailable",
    body: "Promotion is temporarily unavailable. Please pause sharing this link while the business completes its checks.",
  },
  funding_paused: {
    title: "This referral link is paused",
    body: "The business has paused its funding, so new referrals are not being accepted right now. Please pause sharing this link until the business restores its funding.",
  },
};
const unavailableCopy = {
  title: "This link is temporarily unavailable",
  body: "Please try again shortly.",
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// A static page with no program, creator or business identifiers, never indexed.
function notice(text: { title: string; body: string }, retryAfter: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(text.title)}</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f7f7f6;color:#1a1a1a;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{max-width:34rem;background:#fff;border:1px solid #e3e3e0;border-radius:12px;padding:24px}
h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0;line-height:1.5;color:#444}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}main{background:#1b1b1b;border-color:#333}p{color:#bbb}}
</style>
</head>
<body><main><h1>${escapeHtml(text.title)}</h1><p>${escapeHtml(text.body)}</p></main></body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "text/html; charset=utf-8",
      "retry-after": retryAfter,
      "x-robots-tag": "noindex",
    },
  });
}

export type ReferralLinkHandlerOptions = {
  /** Ask Commish for the handoff. `Commish#links.handoff` has this shape. */
  handoff: (input: { handle: string; signal?: AbortSignal }) => Promise<{ data: LinkHandoff }>;
  /** Render your own not-found response for handles Commish does not know (default: an empty 404). */
  notFound?: (request: Request) => Response | Promise<Response>;
  /** Upper bound for the Commish request in milliseconds (default 4000). Must be a positive number. */
  timeoutMs?: number;
  /**
   * Called when a visit could not be answered for a reason other than an
   * unknown handle: a rejected key, an invalid answer, a timeout. The visitor
   * still gets the static notice; use this to log or alert.
   */
  onError?: (error: unknown, context: { handle: string }) => void;
};

/**
 * Framework-neutral handler for `GET https://brand.com/<prefix>/<handle>`.
 *
 * - known, eligible creator: 307 to the verified destination with `commish_ref`
 * - temporary pause: a static 503 page naming the pause, no redirect
 * - Commish route check: empty 204
 * - unknown handle: 404 (or your `notFound`)
 * - Commish unreachable: a static 503 page; the buyer is never sent on without
 *   the creator's referral
 */
export function createReferralLinkHandler(options: ReferralLinkHandlerOptions) {
  const timeoutMs = options.timeoutMs ?? 4000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TypeError("timeoutMs must be a positive number");
  return async function referralLink(request: Request, handle: string): Promise<Response> {
    const headers = { "cache-control": "private, no-store", "x-robots-tag": "noindex" };
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
    const missing = () =>
      options.notFound ? options.notFound(request) : new Response(null, { status: 404, headers });
    if (typeof handle !== "string" || !HANDLE.test(handle)) return missing();
    try {
      const { data } = await options.handoff({
        handle,
        signal: AbortSignal.timeout(timeoutMs),
      });
      assertLinkHandoff(data);
      if (data.status === "probe") return new Response(null, { status: 204, headers });
      if (data.status === "paused") return notice(pauseCopy[data.reason], "900");
      return new Response(null, {
        status: 307,
        headers: { ...headers, location: data.location, "referrer-policy": "no-referrer" },
      });
    } catch (error) {
      if (object(error) && error.name === "CommishError" && error.status === 404) return missing();
      try {
        options.onError?.(error, { handle });
      } catch {
        /* A failing hook must not change what the visitor gets. */
      }
      return notice(unavailableCopy, "60");
    }
  };
}
