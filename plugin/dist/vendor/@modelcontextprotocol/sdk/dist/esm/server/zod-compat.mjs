import { object as objectType } from "../../../../../zod/v3/types.mjs";
import { safeParse as safeParse$1, safeParseAsync as safeParseAsync$1 } from "../../../../../zod/v4/core/parse.mjs";
import { object } from "../../../../../zod/v4/mini/schemas.mjs";

//#region node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js
function isZ4Schema(s) {
	return !!s._zod;
}
function objectFromShape(shape) {
	const values = Object.values(shape);
	if (values.length === 0) return object({});
	const allV4 = values.every(isZ4Schema);
	const allV3 = values.every((s) => !isZ4Schema(s));
	if (allV4) return object(shape);
	if (allV3) return objectType(shape);
	throw new Error("Mixed Zod versions detected in object shape.");
}
function safeParse(schema, data) {
	if (isZ4Schema(schema)) return safeParse$1(schema, data);
	return schema.safeParse(data);
}
async function safeParseAsync(schema, data) {
	if (isZ4Schema(schema)) return await safeParseAsync$1(schema, data);
	return await schema.safeParseAsync(data);
}
function getObjectShape(schema) {
	if (!schema) return void 0;
	let rawShape;
	if (isZ4Schema(schema)) rawShape = schema._zod?.def?.shape;
	else rawShape = schema.shape;
	if (!rawShape) return void 0;
	if (typeof rawShape === "function") try {
		return rawShape();
	} catch {
		return;
	}
	return rawShape;
}
/**
* Normalizes a schema to an object schema. Handles both:
* - Already-constructed object schemas (v3 or v4)
* - Raw shapes that need to be wrapped into object schemas
*/
function normalizeObjectSchema(schema) {
	if (!schema) return void 0;
	if (typeof schema === "object") {
		const asV3 = schema;
		const asV4 = schema;
		if (!asV3._def && !asV4._zod) {
			const values = Object.values(schema);
			if (values.length > 0 && values.every((v) => typeof v === "object" && v !== null && (v._def !== void 0 || v._zod !== void 0 || typeof v.parse === "function"))) return objectFromShape(schema);
		}
	}
	if (isZ4Schema(schema)) {
		const def = schema._zod?.def;
		if (def && (def.type === "object" || def.shape !== void 0)) return schema;
	} else if (schema.shape !== void 0) return schema;
}
function getDotPath(path) {
	if (path.length === 0) return "object root";
	return path.reduce((acc, seg, index) => {
		if (index === 0) return String(seg);
		if (typeof seg === "number") return `${acc}[${seg}]`;
		return `${acc}.${seg}`;
	}, "");
}
/**
* Safely extracts an error message from a parse result error.
* Zod errors can have different structures, so we handle various cases.
*/
function getParseErrorMessage(error) {
	if (error && typeof error === "object") {
		if ("issues" in error && Array.isArray(error.issues) && error.issues.length > 0) return error.issues.map((i) => {
			if (!i.path?.length) return i.message;
			return `${i.message} at ${getDotPath(i.path)}`;
		}).join("\n");
		if ("message" in error && typeof error.message === "string") return error.message;
		try {
			return JSON.stringify(error);
		} catch {
			return String(error);
		}
	}
	return String(error);
}
/**
* Gets the description from a schema, if available.
* Works with both Zod v3 and v4.
*
* Both versions expose a `.description` getter that returns the description
* from their respective internal storage (v3: _def, v4: globalRegistry).
*/
function getSchemaDescription(schema) {
	return schema.description;
}
/**
* Checks if a schema is optional.
* Works with both Zod v3 and v4.
*/
function isSchemaOptional(schema) {
	if (isZ4Schema(schema)) return schema._zod?.def?.type === "optional";
	const v3Schema = schema;
	if (typeof schema.isOptional === "function") return schema.isOptional();
	return v3Schema._def?.typeName === "ZodOptional";
}
/**
* Gets the literal value from a schema, if it's a literal schema.
* Works with both Zod v3 and v4.
* Returns undefined if the schema is not a literal or the value cannot be determined.
*/
function getLiteralValue(schema) {
	if (isZ4Schema(schema)) {
		const def = schema._zod?.def;
		if (def) {
			if (def.value !== void 0) return def.value;
			if (Array.isArray(def.values) && def.values.length > 0) return def.values[0];
		}
	}
	const def = schema._def;
	if (def) {
		if (def.value !== void 0) return def.value;
		if (Array.isArray(def.values) && def.values.length > 0) return def.values[0];
	}
	const directValue = schema.value;
	if (directValue !== void 0) return directValue;
}

//#endregion
export { getLiteralValue, getObjectShape, getParseErrorMessage, getSchemaDescription, isSchemaOptional, isZ4Schema, normalizeObjectSchema, objectFromShape, safeParse, safeParseAsync };