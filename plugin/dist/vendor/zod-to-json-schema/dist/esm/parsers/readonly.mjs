import { parseDef } from "../parseDef.mjs";

//#region node_modules/zod-to-json-schema/dist/esm/parsers/readonly.js
const parseReadonlyDef = (def, refs) => {
	return parseDef(def.innerType._def, refs);
};

//#endregion
export { parseReadonlyDef };