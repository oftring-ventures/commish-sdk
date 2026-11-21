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
  /**
   * Present when the root fallback (brand.com/<name>) was asked about.
   * `enabled` is the business's root links switch in the dashboard (null when
   * Commish could not read it); `verified` says unknown one-segment paths reach
   * the link route and forward the check header.
   */
  root?: { enabled?: boolean | null; verified: boolean };
};
/** The header Commish sends with a root check; forward its value unchanged. */
export const LINK_CHECK_HEADER = "x-commish-link-check";
/**
 * Sent with value "1" by a route that answers at the root of the site
 * (brand.com/<name>). Commish answers such a request only while the business
 * has root links switched on.
 */
export const LINK_ROOT_HEADER = "x-commish-link-root";
const CHECK = /^cmprobe-[0-9a-f]{24}$/;

export function linkCheck(value: string): string {
  if (typeof value !== "string" || !CHECK.test(value))
    throw new TypeError("Invalid link check value");
  return value;
}

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
    ) ||
    !(
      value.root === undefined ||
      (object(value.root) &&
        typeof value.root.verified === "boolean" &&
        (value.root.enabled === undefined ||
          value.root.enabled === null ||
          typeof value.root.enabled === "boolean"))
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

type Handoff = (input: {
  handle: string;
  check?: string;
  root?: boolean;
  signal?: AbortSignal;
}) => Promise<{ data: LinkHandoff }>;
type ErrorHook = (error: unknown, context: { handle: string }) => void;

export type ReferralLinkResolverOptions = {
  /** Ask Commish for the handoff. `Commish#links.handoff` has this shape. */
  handoff: Handoff;
  /** Upper bound for the Commish request in milliseconds (default 4000). Must be a positive number. */
  timeoutMs?: number;
  /**
   * Called when a visit could not be answered for a reason other than an
   * unknown handle: a rejected key, an invalid answer, a timeout. Use it to
   * log or alert; it does not change what the visitor gets.
   */
  onError?: ErrorHook;
  /**
   * Set for a route that receives every unknown one-segment path of the site
   * (root links, brand.com/<name>). Its requests are marked as root requests,
   * which Commish answers only while the business has root links switched on,
   * and a path that never resolved is not found during an outage or once the
   * lookup budget is spent, because most root paths are not creators.
   */
  root?: boolean;
  /**
   * Replace the built-in budget for handles never seen to resolve: return false
   * to answer without asking Commish. For a caller that already rations its
   * own lookups of the same paths.
   */
  admit?: () => boolean;
};
export type ReferralLinkHandlerOptions = ReferralLinkResolverOptions & {
  /** Render your own not-found response for handles Commish does not know (default: an empty 404). */
  notFound?: (request: Request) => Response | Promise<Response>;
};
/** What a visit to a referral link comes to, before it is turned into a response. */
export type ReferralLinkOutcome =
  | { kind: "redirect"; location: string }
  | { kind: "paused"; reason: LinkPauseReason }
  /** A route check sent by Commish; nothing was issued. */
  | { kind: "probe" }
  | { kind: "not_found" }
  /** Commish could not be asked. Never forward the buyer without the referral. */
  | { kind: "unavailable" };
/** Per-visit values, for a caller whose configuration is read on each request. */
export type ReferralLinkVisit = {
  /** The value of the check header, when the request carries one. */
  check?: string | null;
  handoff?: Handoff;
  onError?: ErrorHook;
};

// Unknown handles are mostly crawlers and typos. Remember misses briefly and
// cap lookups of handles never seen to resolve, so they do not become Commish
// traffic. A handle that resolved recently is never held back.
const MISS_TTL_MS = 60_000;
const KNOWN_TTL_MS = 600_000;
const MAX_ENTRIES = 1024;
const WINDOW_MS = 10_000;
const MAX_UNKNOWN_LOOKUPS = 60;
// Commish sends a few checks per website and hour, at most a fallback and ten
// names in one run. They are never cached, so they get a small allowance of
// their own instead of an open door; forged checks can use it up for ten
// seconds, which only delays Commish's checks of this site.
const MAX_CHECKS = 20;
function remember(map: Map<string, number>, key: string, ttl: number) {
  map.delete(key);
  if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value as string);
  map.set(key, Date.now() + ttl);
}
function fresh(map: Map<string, number>, key: string) {
  const expiry = map.get(key);
  if (expiry === undefined) return false;
  if (expiry > Date.now()) return true;
  map.delete(key);
  return false;
}
function budget(limit: number) {
  let windowStart = 0;
  let used = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart >= WINDOW_MS) {
      windowStart = now;
      used = 0;
    }
    if (used >= limit) return false;
    used += 1;
    return true;
  };
}

/**
 * Resolves one visit to a referral link without building a response, for
 * frameworks whose pages cannot return one (`createReferralLinkHandler` wraps
 * it for those that can). It remembers misses for a minute and known creators
 * for ten, asks once for a burst on one unknown path, and rations lookups of
 * paths never seen to resolve.
 */
export function createReferralLinkResolver(options: ReferralLinkResolverOptions) {
  const timeoutMs = options.timeoutMs ?? 4000;
  // AbortSignal.timeout accepts whole milliseconds up to 2^31 - 1 and throws otherwise.
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new TypeError(
      "timeoutMs must be a positive number of whole milliseconds, at most 2147483647",
    );
  const misses = new Map<string, number>();
  const known = new Map<string, number>();
  // First lookups of a handle not yet seen to resolve, so a burst on one unknown path asks once.
  const first = new Map<string, Promise<"known" | "miss" | "failed">>();
  const admit = options.admit ?? budget(MAX_UNKNOWN_LOOKUPS);
  const admitCheck = budget(MAX_CHECKS);
  const missing: ReferralLinkOutcome = { kind: "not_found" };
  return async function resolveReferralLink(
    handle: string,
    visit: ReferralLinkVisit = {},
  ): Promise<ReferralLinkOutcome> {
    if (typeof handle !== "string" || !HANDLE.test(handle)) return missing;
    const check = visit.check ?? null;
    if (check !== null && !CHECK.test(check)) return missing;
    // A check from Commish is never cached, and has its own allowance.
    const probing = check !== null || handle.startsWith("cmprobe-");
    // During an outage a creator seen recently gets the notice, not a 404.
    let seen = !probing && fresh(known, handle);
    const failed = (): ReferralLinkOutcome =>
      options.root && !seen ? missing : { kind: "unavailable" };
    let settle: ((outcome: "known" | "miss" | "failed") => void) | undefined;
    if (probing) {
      if (!admitCheck()) return missing;
    } else {
      if (fresh(misses, handle)) return missing;
      if (!seen) {
        const earlier = first.get(handle);
        if (earlier) {
          const outcome = await earlier;
          if (outcome === "miss") return missing;
          if (outcome === "failed") return failed();
          // The earlier lookup has just seen this creator resolve.
          seen = true;
        } else {
          // On a prefix route nearly every path is meant as a creator link, so
          // a spent budget is a temporary notice there, never a dead link.
          if (!admit()) return failed();
          first.set(
            handle,
            new Promise((resolve) => {
              settle = resolve;
            }),
          );
        }
      }
    }
    const done = (outcome: "known" | "miss" | "failed") => {
      if (!settle) return;
      first.delete(handle);
      settle(outcome);
    };
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      // The timeout also ends a custom handoff that ignores the signal, so one
      // stuck request cannot hold every later visit to the same handle.
      const { data } = await Promise.race([
        (visit.handoff ?? options.handoff)({
          handle,
          ...(check === null ? {} : { check }),
          ...(options.root ? { root: true } : {}),
          signal,
        }),
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
      assertLinkHandoff(data);
      if (data.status === "probe") {
        done("miss");
        return { kind: "probe" };
      }
      if (!probing) remember(known, handle, KNOWN_TTL_MS);
      done("known");
      return data.status === "paused"
        ? { kind: "paused", reason: data.reason }
        : // Percent-encoded, so the Location header can always be written.
          { kind: "redirect", location: new URL(data.location).href };
    } catch (error) {
      if (object(error) && error.name === "CommishError" && error.status === 404) {
        if (!probing) remember(misses, handle, MISS_TTL_MS);
        done("miss");
        return missing;
      }
      done("failed");
      try {
        (visit.onError ?? options.onError)?.(error, { handle });
      } catch {
        /* A failing hook must not change what the visitor gets. */
      }
      return failed();
    }
  };
}

/** The static notice a referral link shows for a named pause; `null` reason is an outage. */
export function referralLinkNotice(reason: LinkPauseReason | null): {
  title: string;
  body: string;
} {
  return reason ? pauseCopy[reason] : unavailableCopy;
}

/**
 * Framework-neutral handler for `GET https://brand.com/<prefix>/<handle>`.
 *
 * - known, eligible creator: 307 to the verified destination with `commish_ref`
 * - temporary pause: a static 503 page naming the pause, no redirect
 * - Commish route check: empty 204
 * - unknown handle: 404 (or your `notFound`)
 * - Commish unreachable, or too many never-seen handles at once: a static 503
 *   page; the buyer is never sent on without the creator's referral. With
 *   `root: true` those are the not-found response instead, unless the handle
 *   resolved in the last ten minutes, because most root paths are not creators.
 *
 * The third argument carries per-request values (`handoff`, `onError`,
 * `notFound`) for a caller that reads its configuration on each request.
 */
export function createReferralLinkHandler(options: ReferralLinkHandlerOptions) {
  const resolve = createReferralLinkResolver(options);
  return async function referralLink(
    request: Request,
    handle: string,
    visit: Omit<ReferralLinkVisit, "check"> & {
      notFound?: ReferralLinkHandlerOptions["notFound"];
    } = {},
  ): Promise<Response> {
    const headers = { "cache-control": "private, no-store", "x-robots-tag": "noindex" };
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
    const outcome = await resolve(handle, {
      ...visit,
      check: request.headers.get(LINK_CHECK_HEADER),
    });
    if (outcome.kind === "not_found") {
      const notFound = visit.notFound ?? options.notFound;
      return notFound ? notFound(request) : new Response(null, { status: 404, headers });
    }
    if (outcome.kind === "probe") return new Response(null, { status: 204, headers });
    if (outcome.kind === "unavailable") return notice(unavailableCopy, "60");
    if (outcome.kind === "paused") return notice(pauseCopy[outcome.reason], "900");
    return new Response(null, {
      status: 307,
      headers: { ...headers, location: outcome.location, "referrer-policy": "no-referrer" },
    });
  };
}
