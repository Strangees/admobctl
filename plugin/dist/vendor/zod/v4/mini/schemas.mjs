import { clone, installLazyProp, normalizeParams, own } from "../core/util.mjs";
import { $constructor } from "../core/core.mjs";
import { parse, parseAsync, safeParse, safeParseAsync } from "../core/parse.mjs";
import { $ZodObject, $ZodType } from "../core/schemas.mjs";

//#region node_modules/zod/v4/mini/schemas.js
const ZodMiniType = /*@__PURE__*/ $constructor("ZodMiniType", (inst, def) => {
	if (!inst._zod) throw new Error("Uninitialized schema in ZodMiniType.");
	$ZodType.init(inst, def);
	inst.def = def;
	inst.type = def.type;
}, {
	get with() {
		return this.check;
	},
	set with(value) {
		own(this, "with", value);
	},
	parse(data, params) {
		return parse(this, data, params, { callee: this.parse });
	},
	parseAsync(data, params) {
		return parseAsync(this, data, params, { callee: this.parseAsync });
	},
	safeParse(data, params) {
		return safeParse(this, data, params);
	},
	safeParseAsync(data, params) {
		return safeParseAsync(this, data, params);
	},
	check(...checks) {
		const def = this.def;
		return this.clone({
			...def,
			checks: [...def.checks ?? [], ...checks.map((ch) => typeof ch === "function" ? { _zod: {
				check: ch,
				def: { check: "custom" },
				onattach: []
			} } : ch)]
		}, { parent: true });
	},
	clone(_def, params) {
		return clone(this, _def, params);
	},
	brand() {
		return this;
	},
	register(reg, meta) {
		reg.add(this, meta);
		return this;
	},
	apply(fn, ...args) {
		return args.length === 0 ? fn(this) : fn(this, ...args);
	}
});
const ZodMiniObject = /*@__PURE__*/ $constructor("ZodMiniObject", (inst, def) => {
	$ZodObject.init(inst, def);
	ZodMiniType.init(inst, def);
	installLazyProp(inst, "shape", (self) => self._zod.def.shape, false);
});
// @__NO_SIDE_EFFECTS__
function object(shape, params) {
	const def = {
		type: "object",
		shape: shape ?? {},
		...normalizeParams(params)
	};
	return new ZodMiniObject(def);
}

//#endregion
export { ZodMiniObject, ZodMiniType, object };