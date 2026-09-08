import { createHmac, timingSafeEqual } from "node:crypto";

export function signWebhook(
  payload: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  if (!secret.trim()) throw new Error("Webhook signing secret is required");
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new Error("Webhook timestamp must be a nonnegative integer");
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

export function verifyWebhook(
  payload: string,
  header: string,
  secret: string,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (
    !secret.trim() ||
    !Number.isFinite(toleranceSeconds) ||
    toleranceSeconds < 0 ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    return false;
  const parts = header.split(",").map((part) => part.trim().split("="));
  if (
    parts.filter(([key]) => key === "t").length !== 1 ||
    parts.filter(([key]) => key === "v1").length !== 1
  )
    return false;
  const values = Object.fromEntries(parts);
  const timestamp = Number(values.t);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    Math.abs(now - timestamp) > toleranceSeconds ||
    !values.v1 ||
    !/^[a-f\d]{64}$/i.test(values.v1)
  )
    return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return timingSafeEqual(
    Buffer.from(values.v1, "hex"),
    Buffer.from(expected, "hex"),
  );
}
