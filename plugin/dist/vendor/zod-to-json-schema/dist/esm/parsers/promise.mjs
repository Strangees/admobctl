import { parseDef } from "../parseDef.mjs";

//#region node_modules/zod-to-json-schema/dist/esm/parsers/promise.js
function parsePromiseDef(def, refs) {
	return parseDef(def.type._def, refs);
}

//#endregion
export { parsePromiseDef };