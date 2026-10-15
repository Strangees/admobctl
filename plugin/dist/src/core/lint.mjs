import { AdmobctlError } from "./errors.mjs";
import { approvalLabel } from "./aliases.mjs";
import { formatDate, todayIn } from "./dates.mjs";
import { resolveInsightRange } from "./insights.mjs";

//#region src/core/lint.ts
async function lint(svc, opts = {}) {
	const acct = await svc.account();
	const range = resolveInsightRange(opts, todayIn(acct.reportingTimeZone, svc.now()));
	const from = formatDate(range.startDate);
	const to = formatDate(range.endDate);
	const only = opts.app ? await svc.resolveApp(opts.app) : void 0;
	const notices = [];
	const [allApps, units, allUnits, traffic, groups] = await Promise.all([
		svc.apps(),
		svc.adUnits({ app: opts.app }),
		svc.adUnits(),
		svc.rawReport("network", {
			dateRange: range,
			by: ["ad-unit"],
			metrics: ["requests"],
			filters: opts.app ? { app: [opts.app] } : void 0
		}),
		svc.mediationGroups().catch((err) => {
			if (!(err instanceof AdmobctlError) || err.code !== "BETA_ACCESS_DENIED") throw err;
			notices.push("Mediation groups were not checked: this account cannot read them (AdMob API v1beta, allowlisted accounts only).");
			return null;
		})
	]);
	const apps = only ? allApps.filter((a) => a.appId === only.appId) : allApps;
	notices.push(...traffic.report.warnings.map((w) => `API warning: ${w}`), ...traffic.notices);
	const findings = [];
	for (const a of apps) if (a.approval === "ACTION_REQUIRED") findings.push({
		kind: "app-action-required",
		severity: "problem",
		target: a.alias,
		app: a.alias,
		message: `${a.alias} is marked ${approvalLabel(a.approval)} in AdMob; ad serving may be limited until it is fixed (AdMob → Apps → View all apps).`
	});
	else if (a.approval === "IN_REVIEW") findings.push({
		kind: "app-in-review",
		severity: "note",
		target: a.alias,
		app: a.alias,
		message: `${a.alias} is still in AdMob review; ad serving is limited until it is approved.`
	});
	const mine = new Set(units.map((u) => u.adUnitId));
	const checkedGroups = groups && only ? groups.filter((g) => g.adUnits.some((u) => mine.has(u.adUnitId))) : groups;
	if (checkedGroups) {
		const known = new Set(allUnits.map((u) => u.adUnitId));
		for (const g of checkedGroups.filter((x) => x.state === "ENABLED")) {
			const missing = g.adUnits.filter((u) => !known.has(u.adUnitId));
			if (missing.length) {
				const none = missing.length === g.adUnits.length;
				const ids = missing.map((u) => u.adUnitId).join(", ");
				findings.push({
					kind: "missing-ad-unit",
					severity: none ? "problem" : "note",
					target: g.name,
					message: none ? `Mediation group "${g.name}" is enabled but every ad unit it targets is gone from the account (${ids}), so it cannot serve.` : `Mediation group "${g.name}" also targets ${missing.length === 1 ? "an ad unit that does" : "ad units that do"} not exist in the account: ${ids}. Its other ad units still serve.`
				});
			}
			if (!g.lines.some((l) => l.state === "ENABLED")) findings.push({
				kind: "no-enabled-lines",
				severity: "problem",
				target: g.name,
				message: `Mediation group "${g.name}" is enabled but has no enabled line, so it cannot serve an ad.`
			});
		}
	}
	const requests = /* @__PURE__ */ new Map();
	for (const row of traffic.report.rows) {
		const id = row.dimensions.AD_UNIT?.value ?? "";
		requests.set(id, (requests.get(id) ?? 0) + (row.metrics.AD_REQUESTS ?? 0));
	}
	for (const u of units) if (!requests.get(u.adUnitId)) findings.push({
		kind: "unused-ad-unit",
		severity: "note",
		target: u.name,
		app: u.app,
		message: `${u.app} / ${u.name} (${u.format}) sent no ad requests from ${from} to ${to}: not in a released build, or no longer used.`
	});
	const enabled = (groups ?? []).filter((g) => g.state === "ENABLED");
	if (enabled.length) {
		const grouped = new Set(enabled.flatMap((g) => g.adUnits.map((u) => u.adUnitId)));
		for (const u of units) if (!grouped.has(u.adUnitId)) findings.push({
			kind: "ungrouped-ad-unit",
			severity: "note",
			target: u.name,
			app: u.app,
			message: `${u.app} / ${u.name} (${u.format}) is in no enabled mediation group, so only the AdMob Network serves it.`
		});
	}
	const rank = {
		problem: 0,
		note: 1
	};
	findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
	const problems = findings.filter((f) => f.severity === "problem").length;
	const notes = findings.length - problems;
	const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
	return {
		from,
		to,
		checked: {
			apps: apps.length,
			ad_units: units.length,
			mediation_groups: checkedGroups ? checkedGroups.length : null
		},
		problems,
		findings,
		summary: [findings.length ? `${count(problems, "problem")} and ${count(notes, "note")} in ${count(apps.length, "app")}, ${count(units.length, "ad unit")}${checkedGroups ? ` and ${count(checkedGroups.length, "mediation group")}` : ""}.` : `Nothing to report in ${count(apps.length, "app")}, ${count(units.length, "ad unit")}${checkedGroups ? ` and ${count(checkedGroups.length, "mediation group")}` : ""}.`],
		notices
	};
}

//#endregion
export { lint };