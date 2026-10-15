import { ADMOB_SCOPE, ADSENSE_SCOPE, CLOUD_PLATFORM_SCOPE, MONETIZATION_SCOPE, usageError } from "../errors.mjs";

//#region src/core/setup/features.ts
const FEATURE_ORDER = [
	"read",
	"write",
	"payments"
];
const FEATURES = {
	read: {
		scopes: [ADMOB_SCOPE],
		apis: ["admob.googleapis.com"]
	},
	write: {
		scopes: [MONETIZATION_SCOPE],
		apis: []
	},
	payments: {
		scopes: [ADSENSE_SCOPE],
		apis: ["adsense.googleapis.com"]
	}
};
const sorted = (fs) => {
	const set = new Set(fs);
	return FEATURE_ORDER.filter((f) => set.has(f));
};
/** "payments,write" (or a list) → ["read", "write", "payments"]. Always includes read. */
function parseFeatures(input) {
	const names = (Array.isArray(input) ? input : (input ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
	for (const n of names) if (!FEATURE_ORDER.includes(n)) throw usageError(`Unknown feature "${n}". Features: ${FEATURE_ORDER.join(", ")}.`);
	return sorted(["read", ...names]);
}
/** The features whose scopes a token already has. */
function featuresFromScopes(scopes) {
	return FEATURE_ORDER.filter((f) => FEATURES[f].scopes.every((s) => scopes.includes(s)));
}
function mergeFeatures(...lists) {
	return sorted(lists.flat());
}
/** Scopes to request at sign-in, cloud-platform last (needed for quota projects and enabling APIs). */
function scopesFor(features) {
	return [...sorted(features).flatMap((f) => FEATURES[f].scopes), CLOUD_PLATFORM_SCOPE];
}
function apisFor(features) {
	return sorted(features).flatMap((f) => FEATURES[f].apis);
}
/** " --features write,payments" for the optional features, or "" when only read. */
function featuresFlag(features) {
	const extra = sorted(features).filter((f) => f !== "read");
	return extra.length ? ` --features ${extra.join(",")}` : "";
}

//#endregion
export { FEATURES, FEATURE_ORDER, apisFor, featuresFlag, featuresFromScopes, mergeFeatures, parseFeatures, scopesFor };