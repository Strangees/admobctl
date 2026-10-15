import { parseDef } from "../parseDef.mjs";

//#region node_modules/zod-to-json-schema/dist/esm/parsers/branded.js
function parseBrandedDef(_def, refs) {
	return parseDef(_def.type._def, refs);
}

//#endregion
export { parseBrandedDef };