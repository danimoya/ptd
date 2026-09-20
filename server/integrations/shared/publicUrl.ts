import type { Request } from "express";

/**
 * The public origin of this deployment.
 *
 * Every adapter needs it and every adapter needs the same answer: `PTD_BASE_URL` wins,
 * because behind nginx / NPM the request headers describe the hop and not the origin a
 * third party must reach; otherwise the request tells us (`trust proxy` is on).
 */
export function publicBaseUrl(req?: Request): string {
  const configured = (process.env.PTD_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  if (!req) return "";
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}
