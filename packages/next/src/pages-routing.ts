import {
  Commish,
  CommishError,
  assertCreatorPage,
  type CreatorPage,
} from "@commish/sdk";

export type CreatorPageOptions = {
  secretKey: string;
  programId: string;
  /** Exact verified merchant origin. Never infer this from forwarded headers. */
  origin: string;
  prefix?: string;
  apiUrl?: string;
  integrationPath?: string;
};
export type PageOptionsSource =
  CreatorPageOptions | (() => CreatorPageOptions | Promise<CreatorPageOptions>);

export async function resolveCreatorPage(
  options: CreatorPageOptions,
  handle: string,
): Promise<CreatorPage> {
  const prefix = options.prefix ?? "/c";
  if (!/^\/[a-z][a-z0-9-]{0,29}$/.test(prefix))
    throw new TypeError("Invalid page prefix");
  const { data } = await new Commish({
    secretKey: options.secretKey,
    baseUrl: options.apiUrl,
  }).pages.resolve({
    programId: options.programId,
    handle,
    signal: AbortSignal.timeout(4000),
  });
  assertCreatorPage(data);
  if (
    data.origin !== options.origin ||
    data.canonicalPath !== `${prefix}/${handle}`
  )
    throw new Error(
      "Commish page configuration does not match this installation",
    );
  return data;
}

/** Use ONLY in next.config rewrites().fallback, after all merchant routing. */
export function creatorPageFallbackRewrite(handlerPath = "/api/commish/alias") {
  if (!/^\/[a-zA-Z0-9/-]+$/.test(handlerPath))
    throw new TypeError("Invalid alias handler path");
  return {
    source: "/:creator([a-z0-9][a-z0-9_-]{2,39})",
    destination: `${handlerPath}/:creator`,
  };
}

/** Also usable by an existing CMS catch-all, ONLY after it explicitly relinquishes a path. */
export function createCreatorAliasHandler(source: PageOptionsSource) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ creator: string }> },
  ) {
    const headers = { "cache-control": "private, no-store" };
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405, headers });
    try {
      const options = typeof source === "function" ? await source() : source;
      const page = await resolveCreatorPage(
        options,
        (await context.params).creator,
      );
      if (!page.rootAliasEnabled)
        return new Response(null, { status: 404, headers });
      return new Response(null, {
        status: 307,
        headers: {
          ...headers,
          location: new URL(page.canonicalPath, page.origin).href,
          "x-commish-page-id": page.pageId,
        },
      });
    } catch (error) {
      return new Response(null, {
        status:
          error instanceof CommishError && error.status === 404 ? 404 : 503,
        headers: { ...headers, "retry-after": "30" },
      });
    }
  };
}
