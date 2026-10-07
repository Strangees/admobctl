import { ADMOB_SCOPE, ADSENSE_SCOPE, CLOUD_PLATFORM_SCOPE, MONETIZATION_SCOPE, usageError } from "../errors.js";

/** What a capability needs: `read` is always on; `write` adds the write commands; `payments` adds finance balance. */
export type Feature = "read" | "write" | "payments";

export const FEATURE_ORDER: Feature[] = ["read", "write", "payments"];

export const FEATURES: Record<Feature, { scopes: string[]; apis: string[] }> = {
  read: { scopes: [ADMOB_SCOPE], apis: ["admob.googleapis.com"] },
  write: { scopes: [MONETIZATION_SCOPE], apis: [] },
  payments: { scopes: [ADSENSE_SCOPE], apis: ["adsense.googleapis.com"] },
};

const sorted = (fs: Iterable<Feature>): Feature[] => {
  const set = new Set(fs);
  return FEATURE_ORDER.filter((f) => set.has(f));
};

/** "payments,write" (or a list) → ["read", "write", "payments"]. Always includes read. */
export function parseFeatures(input?: string | string[]): Feature[] {
  const names = (Array.isArray(input) ? input : (input ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    if (!FEATURE_ORDER.includes(n as Feature)) throw usageError(`Unknown feature "${n}". Features: ${FEATURE_ORDER.join(", ")}.`);
  }
  return sorted(["read", ...(names as Feature[])]);
}

/** The features whose scopes a token already has. */
export function featuresFromScopes(scopes: string[]): Feature[] {
  return FEATURE_ORDER.filter((f) => FEATURES[f].scopes.every((s) => scopes.includes(s)));
}

export function mergeFeatures(...lists: Feature[][]): Feature[] {
  return sorted(lists.flat());
}

/**
 * Scopes to request at sign-in, cloud-platform last (needed for quota projects and enabling APIs; gcloud always asks
 * for it, an own OAuth client only when a setup step will call those APIs).
 */
export function scopesFor(features: Feature[], o: { cloudPlatform?: boolean } = {}): string[] {
  return [...sorted(features).flatMap((f) => FEATURES[f].scopes), ...(o.cloudPlatform === false ? [] : [CLOUD_PLATFORM_SCOPE])];
}

export function apisFor(features: Feature[]): string[] {
  return sorted(features).flatMap((f) => FEATURES[f].apis);
}

export function featureForService(service: string): Feature | undefined {
  return FEATURE_ORDER.find((f) => FEATURES[f].apis.includes(service));
}

/** " --features write,payments" for the optional features, or "" when only read. */
export function featuresFlag(features: Feature[]): string {
  const extra = sorted(features).filter((f) => f !== "read");
  return extra.length ? ` --features ${extra.join(",")}` : "";
}
