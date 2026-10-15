import { JSONRPCMessageSchema } from "../types.mjs";

//#region node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js
const STDIO_DEFAULT_MAX_BUFFER_SIZE = 10485760;
/**
* Buffers a continuous stdio stream into discrete JSON-RPC messages.
*/
var ReadBuffer = class {
	constructor(options) {
		this._maxBufferSize = options?.maxBufferSize ?? 10485760;
	}
	append(chunk) {
		if ((this._buffer?.length ?? 0) + chunk.length > this._maxBufferSize) {
			this.clear();
			throw new Error(`ReadBuffer exceeded maximum size of ${this._maxBufferSize} bytes`);
		}
		this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
	}
	readMessage() {
		if (!this._buffer) return null;
		const index = this._buffer.indexOf("\n");
		if (index === -1) return null;
		const line = this._buffer.toString("utf8", 0, index).replace(/\r$/, "");
		this._buffer = this._buffer.subarray(index + 1);
		return deserializeMessage(line);
	}
	clear() {
		this._buffer = void 0;
	}
};
function deserializeMessage(line) {
	return JSONRPCMessageSchema.parse(JSON.parse(line));
}
function serializeMessage(message) {
	return JSON.stringify(message) + "\n";
}

//#endregion
export { ReadBuffer, STDIO_DEFAULT_MAX_BUFFER_SIZE, deserializeMessage, serializeMessage };