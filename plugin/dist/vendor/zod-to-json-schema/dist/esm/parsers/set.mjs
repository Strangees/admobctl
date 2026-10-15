import { setResponseValueAndErrors } from "../errorMessages.mjs";
import { parseDef } from "../parseDef.mjs";

//#region node_modules/zod-to-json-schema/dist/esm/parsers/set.js
function parseSetDef(def, refs) {
	const schema = {
		type: "array",
		uniqueItems: true,
		items: parseDef(def.valueType._def, {
			...refs,
			currentPath: [...refs.currentPath, "items"]
		})
	};
	if (def.minSize) setResponseValueAndErrors(schema, "minItems", def.minSize.value, def.minSize.message, refs);
	if (def.maxSize) setResponseValueAndErrors(schema, "maxItems", def.maxSize.value, def.maxSize.message, refs);
	return schema;
}

//#endregion
export { parseSetDef };