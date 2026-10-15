import { addDays, compareDates } from "./dates.mjs";

//#region src/core/freshness.ts
/** First day with third-party earnings and observed eCPM per mediation group / ad source instance. */
const MEDIATION_DETAIL_START = {
	year: 2019,
	month: 10,
	day: 20
};
/**
* Plain-language notes about data that is not final yet, for a report over `range`.
* AdMob Network data lands about 4h late (some metrics once a day); third-party ad sources 8-24h late.
*/
function freshnessNotices(kind, range, today) {
	const notes = [];
	if (compareDates(range.endDate, today) >= 0) notes.push("Includes today: AdMob data arrives about 4 hours late and some metrics are computed once a day, so today's figures are partial.");
	if (kind === "mediation") {
		if (compareDates(range.endDate, addDays(today, -1)) >= 0) notes.push("Third-party ad sources report 8-24 hours late, so the most recent day's mediation figures may still change.");
		if (compareDates(range.startDate, MEDIATION_DETAIL_START) < 0) notes.push("Third-party earnings and observed eCPM read 0 before 2019-10-20.");
	}
	return notes;
}

//#endregion
export { freshnessNotices };