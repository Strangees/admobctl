import { parseDef } from "../parseDef.mjs";

//#region node_modules/zod-to-json-schema/dist/esm/parsers/catch.js
const parseCatchDef = (def, refs) => {
	return parseDef(def.innerType._def, refs);
};

//#endregion
export { parseCatchDef };