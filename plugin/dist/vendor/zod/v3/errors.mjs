import errorMap from "./locales/en.mjs";

//#region node_modules/zod/v3/errors.js
let overrideErrorMap = errorMap;
function getErrorMap() {
	return overrideErrorMap;
}

//#endregion
export { errorMap as defaultErrorMap, getErrorMap };