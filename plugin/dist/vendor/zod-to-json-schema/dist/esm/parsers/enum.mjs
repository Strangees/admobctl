//#region node_modules/zod-to-json-schema/dist/esm/parsers/enum.js
function parseEnumDef(def) {
	return {
		type: "string",
		enum: Array.from(def.values)
	};
}

//#endregion
export { parseEnumDef };