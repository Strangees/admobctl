//#region node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/mcp-server.js
/**
* Experimental McpServer task features for MCP SDK.
* WARNING: These APIs are experimental and may change without notice.
*
* @experimental
*/
/**
* Experimental task features for McpServer.
*
* Access via `server.experimental.tasks`:
* ```typescript
* server.experimental.tasks.registerToolTask('long-running', config, handler);
* ```
*
* @experimental
*/
var ExperimentalMcpServerTasks = class {
	constructor(_mcpServer) {
		this._mcpServer = _mcpServer;
	}
	registerToolTask(name, config, handler) {
		const execution = {
			taskSupport: "required",
			...config.execution
		};
		if (execution.taskSupport === "forbidden") throw new Error(`Cannot register task-based tool '${name}' with taskSupport 'forbidden'. Use registerTool() instead.`);
		return this._mcpServer._createRegisteredTool(name, config.title, config.description, config.inputSchema, config.outputSchema, config.annotations, execution, config._meta, handler);
	}
};

//#endregion
export { ExperimentalMcpServerTasks };