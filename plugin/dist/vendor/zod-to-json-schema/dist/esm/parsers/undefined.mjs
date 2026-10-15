import { parseAnyDef } from "./any.mjs";

//#region node_modules/zod-to-json-schema/dist/esm/parsers/undefined.js
function parseUndefinedDef(refs) {
	return { not: parseAnyDef(refs) };
}

//#endregion
export { parseUndefinedDef };