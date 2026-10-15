import { InvalidArgumentError } from "./error.mjs";

//#region node_modules/commander/lib/argument.js
var Argument = class {
	/**
	* Initialize a new command argument with the given name and description.
	* The default is that the argument is required, and you can explicitly
	* indicate this with <> around the name. Put [] around the name for an optional argument.
	*
	* @param {string} name
	* @param {string} [description]
	*/
	constructor(name, description) {
		this.description = description || "";
		this.variadic = false;
		this.parseArg = void 0;
		this.defaultValue = void 0;
		this.defaultValueDescription = void 0;
		this.argChoices = void 0;
		switch (name[0]) {
			case "<":
				this.required = true;
				this._name = name.slice(1, -1);
				break;
			case "[":
				this.required = false;
				this._name = name.slice(1, -1);
				break;
			default:
				this.required = true;
				this._name = name;
		}
		if (this._name.endsWith("...")) {
			this.variadic = true;
			this._name = this._name.slice(0, -3);
		}
	}
	/**
	* Return argument name.
	*
	* @return {string}
	*/
	name() {
		return this._name;
	}
	/**
	* @package
	*/
	_collectValue(value, previous) {
		if (previous === this.defaultValue || !Array.isArray(previous)) return [value];
		previous.push(value);
		return previous;
	}
	/**
	* Set the default value, and optionally supply the description to be displayed in the help.
	*
	* @param {*} value
	* @param {string} [description]
	* @return {Argument}
	*/
	default(value, description) {
		this.defaultValue = value;
		this.defaultValueDescription = description;
		return this;
	}
	/**
	* Set the custom handler for processing CLI command arguments into argument values.
	*
	* @param {Function} [fn]
	* @return {Argument}
	*/
	argParser(fn) {
		this.parseArg = fn;
		return this;
	}
	/**
	* Only allow argument value to be one of choices.
	*
	* @param {string[]} values
	* @return {Argument}
	*/
	choices(values) {
		this.argChoices = values.slice();
		this.parseArg = (arg, previous) => {
			if (!this.argChoices.includes(arg)) throw new InvalidArgumentError(`Allowed choices are ${this.argChoices.join(", ")}.`);
			if (this.variadic) return this._collectValue(arg, previous);
			return arg;
		};
		return this;
	}
	/**
	* Make argument required.
	*
	* @returns {Argument}
	*/
	argRequired() {
		this.required = true;
		return this;
	}
	/**
	* Make argument optional.
	*
	* @returns {Argument}
	*/
	argOptional() {
		this.required = false;
		return this;
	}
};
/**
* Takes an argument and returns its human readable equivalent for help usage.
*
* @param {Argument} arg
* @return {string}
* @private
*/
function humanReadableArgName(arg) {
	const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");
	return arg.required ? "<" + nameOutput + ">" : "[" + nameOutput + "]";
}

//#endregion
export { Argument, humanReadableArgName };