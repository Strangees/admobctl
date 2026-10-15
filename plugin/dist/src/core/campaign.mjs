//#region src/core/campaign.ts
/** Metrics that add up across date chunks; the ratios are recomputed from them. */
const ADDITIVE = [
	"IMPRESSIONS",
	"CLICKS",
	"INSTALLS",
	"ESTIMATED_COST",
	"INTERACTIONS"
];
/** Base metrics a ratio needs when chunks have to be added up. */
const RATIO_BASES = {
	CLICK_THROUGH_RATE: ["CLICKS", "IMPRESSIONS"],
	AVERAGE_CPI: ["ESTIMATED_COST", "INSTALLS"]
};
/** Add up campaign report chunks row by row (same dimension values), then recompute CTR and CPI. */
function mergeCampaignChunks(chunks, dimensions) {
	const byKey = /* @__PURE__ */ new Map();
	for (const chunk of chunks) for (const row of chunk.rows) {
		const key = JSON.stringify(dimensions.map((d) => row.dimensions[d]?.value ?? ""));
		const hit = byKey.get(key);
		if (!hit) {
			byKey.set(key, {
				dimensions: row.dimensions,
				metrics: { ...row.metrics }
			});
			continue;
		}
		for (const m of ADDITIVE) if (m in row.metrics || m in hit.metrics) hit.metrics[m] = (hit.metrics[m] ?? 0) + (row.metrics[m] ?? 0);
	}
	const rows = [...byKey.values()];
	for (const r of rows) {
		const m = r.metrics;
		if ("CLICK_THROUGH_RATE" in m) m.CLICK_THROUGH_RATE = m.IMPRESSIONS ? (m.CLICKS ?? 0) / m.IMPRESSIONS : 0;
		if ("AVERAGE_CPI" in m) m.AVERAGE_CPI = m.INSTALLS ? Math.round((m.ESTIMATED_COST ?? 0) / m.INSTALLS) : 0;
	}
	return {
		rows,
		warnings: chunks.flatMap((c) => c.warnings)
	};
}

//#endregion
export { RATIO_BASES, mergeCampaignChunks };