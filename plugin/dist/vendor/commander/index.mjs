import { CommanderError, InvalidArgumentError } from "./lib/error.mjs";
import { Argument } from "./lib/argument.mjs";
import { Help } from "./lib/help.mjs";
import { Option } from "./lib/option.mjs";
import { Command } from "./lib/command.mjs";

//#region node_modules/commander/index.js
const program = new Command();

//#endregion
export { Command, CommanderError, Option };