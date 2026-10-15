//#region node_modules/zod-to-json-schema/dist/esm/parsers/nativeEnum.js
function parseNativeEnumDef(def) {
	const object = def.values;
	const actualValues = Object.keys(def.values).filter((key) => {
		return typeof object[object[key]] !== "number";
	}).map((key) => object[key]);
	const parsedTypes = Array.from(new Set(actualValues.map((values) => typeof values)));
	return {
		type: parsedTypes.length === 1 ? parsedTypes[0] === "string" ? "string" : "number" : ["string", "number"],
		enum: actualValues
	};
}

//#endregion
export { parseNativeEnumDef };