import { log } from "./log.mjs";

//#region src/core/app-ads.ts
/** Google's certification authority ID (TAG-ID), the 4th field of an AdMob line. */
const GOOGLE_CERT_ID = "f08c47fec0942fa0";
const ITUNES_LOOKUP = "https://itunes.apple.com/lookup";
const TIMEOUT_MS = 1e4;
/** Records from an app-ads.txt body (IAB format). Comments, blank lines and `key=value` variables are skipped. */
function parseAppAds(body) {
	const records = [];
	body.split(/\r?\n/).forEach((raw, i) => {
		const text = raw.replace(/#.*/, "").trim();
		if (!text || /^[a-z_-]+\s*=/i.test(text)) return;
		const [domain, publisherId, relationship, certId] = text.split(",").map((f) => f.trim());
		if (!domain || !publisherId || !relationship) return;
		const rec = {
			domain: domain.toLowerCase(),
			publisherId: publisherId.toLowerCase(),
			relationship: relationship.toUpperCase(),
			line: i + 1
		};
		if (certId) rec.certId = certId.toLowerCase();
		records.push(rec);
	});
	return records;
}
/**
* The host AdMob crawls for a developer website: the hostname only, without a leading www. or m.
* Undefined when the input is not an http(s) website.
*/
function appAdsHost(website) {
	const s = website.trim();
	let url;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
	} catch {
		return;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return void 0;
	const host = url.hostname.toLowerCase();
	if (!host.includes(".")) return void 0;
	return host.replace(/^(www|m)\./, "");
}
/** Statuses that cost ad revenue. unknown-website and not-linked are gaps in what we could check, not findings. */
const PROBLEMS = /* @__PURE__ */ new Set([
	"missing-file",
	"html",
	"no-line",
	"reseller-only",
	"unreachable",
	"no-website"
]);
async function probe(doFetch, url) {
	log.debug(`GET ${url}`);
	try {
		const res = await doFetch(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		const body = await res.text();
		const finalUrl = res.url || url;
		if (!res.ok) return {
			kind: "status",
			url: finalUrl,
			status: res.status
		};
		if (/html/i.test(res.headers.get("content-type") ?? "") || body.trimStart().startsWith("<")) return {
			kind: "html",
			url: finalUrl
		};
		return {
			kind: "file",
			url: finalUrl,
			body
		};
	} catch (err) {
		return {
			kind: "error",
			url,
			message: err.message
		};
	}
}
/** https first, then http, like AdMob's crawler. */
async function fetchAppAds(doFetch, host) {
	const httpsUrl = `https://${host}/app-ads.txt`;
	const httpsResult = await probe(doFetch, httpsUrl);
	if (httpsResult.kind === "file") return {
		checked: [httpsUrl],
		result: httpsResult
	};
	const httpUrl = `http://${host}/app-ads.txt`;
	const httpResult = await probe(doFetch, httpUrl);
	if (httpResult.kind === "file") return {
		checked: [httpsUrl, httpUrl],
		result: httpResult
	};
	return {
		checked: [httpsUrl, httpUrl],
		result: httpsResult.kind === "error" ? httpResult : httpsResult
	};
}
/** App Store ID → marketing URL (null when the listing has none). Undefined when the lookup itself failed. */
async function lookupIosWebsites(doFetch, storeIds) {
	if (!storeIds.length) return /* @__PURE__ */ new Map();
	const url = `${ITUNES_LOOKUP}?id=${storeIds.map(encodeURIComponent).join(",")}`;
	log.debug(`GET ${url}`);
	try {
		const res = await doFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) return void 0;
		const data = await res.json();
		return new Map((data.results ?? []).map((r) => [String(r.trackId), r.sellerUrl || null]));
	} catch (err) {
		log.debug(`App Store lookup failed: ${err.message}`);
		return;
	}
}
function fallbackSite(opts, configured, notes, unknownDetail) {
	if (opts.website) return {
		website: opts.website,
		source: "flag",
		notes
	};
	if (configured) return {
		website: configured,
		source: "config",
		notes
	};
	return {
		status: "unknown-website",
		detail: unknownDetail,
		notes
	};
}
const SET_WEBSITE = "pass --website <url> or run: admobctl config set websites.<alias> <url>";
/** The configured website for one app: per-app (by alias, then app ID), then profile-wide. */
function configuredWebsite(app, profile) {
	return profile.websites?.[app.alias] ?? profile.websites?.[app.appId] ?? profile.website;
}
function siteFor(app, ios, opts, configured) {
	if (!app.storeId) return {
		status: "not-linked",
		detail: "Not linked to an app store; AdMob verifies app-ads.txt only for store-linked apps.",
		notes: []
	};
	if (app.platform === "IOS") {
		const hit = ios?.get(app.storeId);
		if (hit) return {
			website: hit,
			source: "store",
			notes: []
		};
		if (hit === null) return {
			status: "no-website",
			detail: "The App Store listing has no marketing URL, so AdMob cannot find app-ads.txt. Add one in App Store Connect.",
			notes: []
		};
		const why = ios ? "was not found in the App Store lookup (US store)" : "could not be looked up in the App Store";
		return fallbackSite(opts, configured, [`The listing ${why}; checked the ${opts.website ? "--website" : "configured"} website instead.`], `The listing ${why}; ${SET_WEBSITE}`);
	}
	return fallbackSite(opts, configured, [], `Google Play listings cannot be read without Play Console access. AdMob uses the website in the listing's contact details; ${SET_WEBSITE}`);
}
function verdict(result, host, publisherId) {
	if (result.kind === "error") return {
		status: "unreachable",
		detail: `Could not reach ${host}: ${result.message}`,
		notes: []
	};
	if (result.kind === "status") return {
		status: "missing-file",
		detail: `${result.url} returned HTTP ${result.status}.`,
		notes: []
	};
	if (result.kind === "html") return {
		status: "html",
		detail: `${result.url} returned a web page, not a plain-text app-ads.txt.`,
		fileUrl: result.url,
		notes: []
	};
	const google = parseAppAds(result.body).filter((r) => r.domain === "google.com");
	const mine = google.filter((r) => r.publisherId === publisherId.toLowerCase());
	const direct = mine.find((r) => r.relationship === "DIRECT");
	if (direct) {
		const notes = direct.certId && direct.certId !== "f08c47fec0942fa0" ? [`Line ${direct.line} has certification ID ${direct.certId}; Google's is ${GOOGLE_CERT_ID}.`] : [];
		return {
			status: "ok",
			detail: `${result.url} lists ${publisherId} as DIRECT (line ${direct.line}).`,
			fileUrl: result.url,
			notes
		};
	}
	if (mine.length) return {
		status: "reseller-only",
		detail: `${result.url} lists ${publisherId} as ${mine[0].relationship} (line ${mine[0].line}); AdMob needs DIRECT.`,
		fileUrl: result.url,
		notes: []
	};
	const others = [...new Set(google.map((r) => r.publisherId))];
	const listed = others.length > 3 ? `${others.slice(0, 3).join(", ")} and ${others.length - 3} more` : others.join(", ");
	return {
		status: "no-line",
		detail: `${result.url} has no google.com line for ${publisherId}${others.length ? ` (it lists ${listed})` : ""}.`,
		fileUrl: result.url,
		notes: []
	};
}
function summarize(apps, expectedLine) {
	const problems = apps.filter((a) => PROBLEMS.has(a.status)).length;
	const ok = apps.filter((a) => a.status === "ok").length;
	const unknown = apps.filter((a) => a.status === "unknown-website").length;
	const summary = [];
	if (problems) {
		summary.push(`${problems} of ${apps.length} apps have an app-ads.txt problem that can cost ad revenue.`);
		summary.push(`Each developer website needs this line in /app-ads.txt: ${expectedLine}`);
		summary.push("AdMob can take up to 24 hours to see a fixed file.");
	} else if (ok) summary.push(`${ok} of ${apps.length} apps have a valid app-ads.txt line.`);
	if (unknown) summary.push(`${unknown} apps were not checked because their developer website is unknown; ${SET_WEBSITE}`);
	return {
		problems,
		summary
	};
}
/**
* Check each app's app-ads.txt the way AdMob's crawler does: developer website from the store listing,
* hostname without www./m., https then http, and a google.com line with this publisher ID marked DIRECT.
*/
async function checkAppAds(svc, opts) {
	const [account, all] = await Promise.all([svc.account(), svc.apps()]);
	const apps = opts.app ? [await svc.resolveApp(opts.app)] : all;
	const doFetch = svc.fetch;
	const ios = await lookupIosWebsites(doFetch, [...new Set(apps.filter((a) => a.platform === "IOS" && a.storeId).map((a) => a.storeId))]);
	const expectedLine = `google.com, ${account.publisherId}, DIRECT, ${GOOGLE_CERT_ID}`;
	const byHost = /* @__PURE__ */ new Map();
	const results = await Promise.all(apps.map(async (app) => {
		const base = {
			app: app.alias,
			appId: app.appId,
			name: app.name,
			platform: app.platform
		};
		const site = siteFor(app, ios, opts, configuredWebsite(app, svc.profile));
		if (site.status) return {
			...base,
			status: site.status,
			detail: site.detail,
			checked: [],
			notes: site.notes
		};
		const where = {
			website: site.website,
			websiteSource: site.source
		};
		const host = appAdsHost(site.website);
		if (!host) return {
			...base,
			...where,
			status: "no-website",
			detail: `"${site.website}" is not a website URL.`,
			checked: [],
			notes: site.notes
		};
		let pending = byHost.get(host);
		if (!pending) byHost.set(host, pending = fetchAppAds(doFetch, host));
		const { checked, result } = await pending;
		const v = verdict(result, host, account.publisherId);
		return {
			...base,
			...where,
			...v,
			checked,
			notes: [...site.notes, ...v.notes]
		};
	}));
	return {
		account: account.name,
		publisherId: account.publisherId,
		expectedLine,
		apps: results,
		...summarize(results, expectedLine)
	};
}

//#endregion
export { GOOGLE_CERT_ID, appAdsHost, checkAppAds, parseAppAds };