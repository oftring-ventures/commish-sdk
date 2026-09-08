export type CommishBrowserOptions = {
  publishableKey: string;
  applicationId: string;
  capturePath?: string;
};

const captureRequests = new Map<string, Promise<boolean>>();
const CAPTURE_ID_STORAGE_KEY = "commish_capture_id";
let fallbackCaptureId: string | undefined;

function createCaptureId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function getCaptureId(): string {
  try {
    const existing = window.sessionStorage.getItem(CAPTURE_ID_STORAGE_KEY);
    if (existing && /^[a-f\d]{32}$/.test(existing)) return existing;
    const created = createCaptureId();
    window.sessionStorage.setItem(CAPTURE_ID_STORAGE_KEY, created);
    return created;
  } catch {
    fallbackCaptureId ??= createCaptureId();
    return fallbackCaptureId;
  }
}

export function captureReferral(
  options: CommishBrowserOptions,
): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (
    typeof options.publishableKey !== "string" ||
    !/^cm_(?:test|live)_pk_[A-Za-z0-9_-]{12,}$/.test(options.publishableKey)
  )
    return Promise.resolve(false);
  const url = new URL(window.location.href);
  const token = url.searchParams.get("commish_ref");
  if (!token) return Promise.resolve(false);
  const capturePath = options.capturePath ?? "/api/commish/attribution";
  let target: URL;
  try {
    target = new URL(capturePath, url);
    if (target.origin !== url.origin || target.username || target.password)
      return Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
  const captureId = getCaptureId();
  const requestKey = `${target.href}\u0000${options.publishableKey}\u0000${options.applicationId}\u0000${token}`;
  const existing = captureRequests.get(requestKey);
  if (existing) return existing;
  const capture = fetch(target.href, {
    method: "POST",
    redirect: "error",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-commish-capture-id": captureId,
      "x-commish-publishable-key": options.publishableKey,
    },
    body: JSON.stringify({ token, applicationId: options.applicationId }),
  })
    .then((response) => {
      if (!response.ok) return false;
      const currentUrl = new URL(window.location.href);
      if (currentUrl.searchParams.get("commish_ref") === token) {
        currentUrl.searchParams.delete("commish_ref");
        window.history.replaceState(window.history.state, "", currentUrl);
      }
      return true;
    })
    .catch(() => false);
  captureRequests.set(requestKey, capture);
  void capture.finally(() => captureRequests.delete(requestKey));
  return capture;
}
