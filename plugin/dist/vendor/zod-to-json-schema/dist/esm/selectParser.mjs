import { ZodFirstPartyTypeKind } from "../../../zod/v3/types.mjs";
import { parseAnyDef } from "./parsers/any.mjs";
import { parseArrayDef } from "./parsers/array.mjs";
import { parseBigintDef } from "./parsers/bigint.mjs";
import { parseBooleanDef } from "./parsers/boolean.mjs";
import { parseBrandedDef } from "./parsers/branded.mjs";
import { parseCatchDef } from "./parsers/catch.mjs";
import { parseDateDef } from "./parsers/date.mjs";
import { parseDefaultDef } from "./parsers/default.mjs";
import { parseEffectsDef } from "./parsers/effects.mjs";
import { parseEnumDef } from "./parsers/enum.mjs";
import { parseIntersectionDef } from "./parsers/intersection.mjs";
import { parseLiteralDef } from "./parsers/literal.mjs";
import { parseStringDef } from "./parsers/string.mjs";
import { parseRecordDef } from "./parsers/record.mjs";
import { parseMapDef } from "./parsers/map.mjs";
import { parseNativeEnumDef } from "./parsers/nativeEnum.mjs";
import { parseNeverDef } from "./parsers/never.mjs";
import { parseNullDef } from "./parsers/null.mjs";
import { parseUnionDef } from "./parsers/union.mjs";
import { parseNullableDef } from "./parsers/nullable.mjs";
import { parseNumberDef } from "./parsers/number.mjs";
import { parseObjectDef } from "./parsers/object.mjs";
import { parseOptionalDef } from "./parsers/optional.mjs";
import { parsePipelineDef } from "./parsers/pipeline.mjs";
import { parsePromiseDef } from "./parsers/promise.mjs";
import { parseSetDef } from "./parsers/set.mjs";
import { parseTupleDef } from "./parsers/tuple.mjs";
import { parseUndefinedDef } from "./parsers/undefined.mjs";
import { parseUnknownDef } from "./parsers/unknown.mjs";
import { parseReadonlyDef } from "./parsers/readonly.mjs";

//#region node_modules/zod-to-json-schema/dist/esm/selectParser.js
const selectParser = (def, typeName, refs) => {
	switch (typeName) {
		case ZodFirstPartyTypeKind.ZodString: return parseStringDef(def, refs);
		case ZodFirstPartyTypeKind.ZodNumber: return parseNumberDef(def, refs);
		case ZodFirstPartyTypeKind.ZodObject: return parseObjectDef(def, refs);
		case ZodFirstPartyTypeKind.ZodBigInt: return parseBigintDef(def, refs);
		case ZodFirstPartyTypeKind.ZodBoolean: return parseBooleanDef();
		case ZodFirstPartyTypeKind.ZodDate: return parseDateDef(def, refs);
		case ZodFirstPartyTypeKind.ZodUndefined: return parseUndefinedDef(refs);
		case ZodFirstPartyTypeKind.ZodNull: return parseNullDef(refs);
		case ZodFirstPartyTypeKind.ZodArray: return parseArrayDef(def, refs);
		case ZodFirstPartyTypeKind.ZodUnion:
		case ZodFirstPartyTypeKind.ZodDiscriminatedUnion: return parseUnionDef(def, refs);
		case ZodFirstPartyTypeKind.ZodIntersection: return parseIntersectionDef(def, refs);
		case ZodFirstPartyTypeKind.ZodTuple: return parseTupleDef(def, refs);
		case ZodFirstPartyTypeKind.ZodRecord: return parseRecordDef(def, refs);
		case ZodFirstPartyTypeKind.ZodLiteral: return parseLiteralDef(def, refs);
		case ZodFirstPartyTypeKind.ZodEnum: return parseEnumDef(def);
		case ZodFirstPartyTypeKind.ZodNativeEnum: return parseNativeEnumDef(def);
		case ZodFirstPartyTypeKind.ZodNullable: return parseNullableDef(def, refs);
		case ZodFirstPartyTypeKind.ZodOptional: return parseOptionalDef(def, refs);
		case ZodFirstPartyTypeKind.ZodMap: return parseMapDef(def, refs);
		case ZodFirstPartyTypeKind.ZodSet: return parseSetDef(def, refs);
		case ZodFirstPartyTypeKind.ZodLazy: return () => def.getter()._def;
		case ZodFirstPartyTypeKind.ZodPromise: return parsePromiseDef(def, refs);
		case ZodFirstPartyTypeKind.ZodNaN:
		case ZodFirstPartyTypeKind.ZodNever: return parseNeverDef(refs);
		case ZodFirstPartyTypeKind.ZodEffects: return parseEffectsDef(def, refs);
		case ZodFirstPartyTypeKind.ZodAny: return parseAnyDef(refs);
		case ZodFirstPartyTypeKind.ZodUnknown: return parseUnknownDef(refs);
		case ZodFirstPartyTypeKind.ZodDefault: return parseDefaultDef(def, refs);
		case ZodFirstPartyTypeKind.ZodBranded: return parseBrandedDef(def, refs);
		case ZodFirstPartyTypeKind.ZodReadonly: return parseReadonlyDef(def, refs);
		case ZodFirstPartyTypeKind.ZodCatch: return parseCatchDef(def, refs);
		case ZodFirstPartyTypeKind.ZodPipeline: return parsePipelineDef(def, refs);
		case ZodFirstPartyTypeKind.ZodFunction:
		case ZodFirstPartyTypeKind.ZodVoid:
		case ZodFirstPartyTypeKind.ZodSymbol: return;
		default: return ((_) => void 0)(typeName);
	}
};

//#endregion
export { selectParser };