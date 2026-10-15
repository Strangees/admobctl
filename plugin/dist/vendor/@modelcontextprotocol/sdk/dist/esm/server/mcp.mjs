import { getLiteralValue, getObjectShape, getParseErrorMessage, getSchemaDescription, isSchemaOptional, normalizeObjectSchema, objectFromShape, safeParseAsync } from "./zod-compat.mjs";
import { ZodOptional } from "../../../../../zod/v4/classic/schemas.mjs";
import { CallToolRequestSchema, CompleteRequestSchema, ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema, assertCompleteRequestPrompt, assertCompleteRequestResourceTemplate } from "../types.mjs";
import { toJsonSchemaCompat } from "./zod-json-schema-compat.mjs";
import { Server } from "./index.mjs";
import { getCompleter, isCompletable } from "./completable.mjs";
import { validateAndWarnToolName } from "../shared/toolNameValidation.mjs";
import { ExperimentalMcpServerTasks } from "../experimental/tasks/mcp-server.mjs";

//#region node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js
/**
* High-level MCP server that provides a simpler API for working with resources, tools, and prompts.
* For advanced usage (like sending notifications or setting custom request handlers), use the underlying
* Server instance available via the `server` property.
*/
var McpServer = class {
	constructor(serverInfo, options) {
		this._registeredResources = {};
		this._registeredResourceTemplates = {};
		this._registeredTools = {};
		this._registeredPrompts = {};
		this._toolHandlersInitialized = false;
		this._completionHandlerInitialized = false;
		this._resourceHandlersInitialized = false;
		this._promptHandlersInitialized = false;
		this.server = new Server(serverInfo, options);
	}
	/**
	* Access experimental features.
	*
	* WARNING: These APIs are experimental and may change without notice.
	*
	* @experimental
	*/
	get experimental() {
		if (!this._experimental) this._experimental = { tasks: new ExperimentalMcpServerTasks(this) };
		return this._experimental;
	}
	/**
	* Attaches to the given transport, starts it, and starts listening for messages.
	*
	* The `server` object assumes ownership of the Transport, replacing any callbacks that have already been set, and expects that it is the only user of the Transport instance going forward.
	*/
	async connect(transport) {
		return await this.server.connect(transport);
	}
	/**
	* Closes the connection.
	*/
	async close() {
		await this.server.close();
	}
	setToolRequestHandlers() {
		if (this._toolHandlersInitialized) return;
		this.server.assertCanSetRequestHandler(getMethodValue(ListToolsRequestSchema));
		this.server.assertCanSetRequestHandler(getMethodValue(CallToolRequestSchema));
		this.server.registerCapabilities({ tools: { listChanged: true } });
		this.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: Object.entries(this._registeredTools).filter(([, tool]) => tool.enabled).map(([name, tool]) => {
			const toolDefinition = {
				name,
				title: tool.title,
				description: tool.description,
				inputSchema: (() => {
					const obj = normalizeObjectSchema(tool.inputSchema);
					return obj ? toJsonSchemaCompat(obj, {
						strictUnions: true,
						pipeStrategy: "input"
					}) : EMPTY_OBJECT_JSON_SCHEMA;
				})(),
				annotations: tool.annotations,
				execution: tool.execution,
				_meta: tool._meta
			};
			if (tool.outputSchema) {
				const obj = normalizeObjectSchema(tool.outputSchema);
				if (obj) toolDefinition.outputSchema = toJsonSchemaCompat(obj, {
					strictUnions: true,
					pipeStrategy: "output"
				});
			}
			return toolDefinition;
		}) }));
		this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			try {
				const tool = this._registeredTools[request.params.name];
				if (!tool) throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
				if (!tool.enabled) throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} disabled`);
				const isTaskRequest = !!request.params.task;
				const taskSupport = tool.execution?.taskSupport;
				const isTaskHandler = "createTask" in tool.handler;
				if ((taskSupport === "required" || taskSupport === "optional") && !isTaskHandler) throw new McpError(ErrorCode.InternalError, `Tool ${request.params.name} has taskSupport '${taskSupport}' but was not registered with registerToolTask`);
				if (taskSupport === "required" && !isTaskRequest) throw new McpError(ErrorCode.MethodNotFound, `Tool ${request.params.name} requires task augmentation (taskSupport: 'required')`);
				if (taskSupport === "optional" && !isTaskRequest && isTaskHandler) return await this.handleAutomaticTaskPolling(tool, request, extra);
				const args = await this.validateToolInput(tool, request.params.arguments, request.params.name);
				const result = await this.executeToolHandler(tool, args, extra);
				if (isTaskRequest) return result;
				await this.validateToolOutput(tool, result, request.params.name);
				return result;
			} catch (error) {
				if (error instanceof McpError) {
					if (error.code === ErrorCode.UrlElicitationRequired) throw error;
				}
				return this.createToolError(error instanceof Error ? error.message : String(error));
			}
		});
		this._toolHandlersInitialized = true;
	}
	/**
	* Creates a tool error result.
	*
	* @param errorMessage - The error message.
	* @returns The tool error result.
	*/
	createToolError(errorMessage) {
		return {
			content: [{
				type: "text",
				text: errorMessage
			}],
			isError: true
		};
	}
	/**
	* Validates tool input arguments against the tool's input schema.
	*/
	async validateToolInput(tool, args, toolName) {
		if (!tool.inputSchema) return;
		const schemaToParse = normalizeObjectSchema(tool.inputSchema) ?? tool.inputSchema;
		const parseResult = await safeParseAsync(schemaToParse, args);
		if (!parseResult.success) {
			const error = "error" in parseResult ? parseResult.error : "Unknown error";
			const errorMessage = getParseErrorMessage(error);
			throw new McpError(ErrorCode.InvalidParams, `Input validation error: Invalid arguments for tool ${toolName}: ${errorMessage}`);
		}
		return parseResult.data;
	}
	/**
	* Validates tool output against the tool's output schema.
	*/
	async validateToolOutput(tool, result, toolName) {
		if (!tool.outputSchema) return;
		if (!("content" in result)) return;
		if (result.isError) return;
		if (!result.structuredContent) throw new McpError(ErrorCode.InvalidParams, `Output validation error: Tool ${toolName} has an output schema but no structured content was provided`);
		const outputObj = normalizeObjectSchema(tool.outputSchema);
		const parseResult = await safeParseAsync(outputObj, result.structuredContent);
		if (!parseResult.success) {
			const error = "error" in parseResult ? parseResult.error : "Unknown error";
			const errorMessage = getParseErrorMessage(error);
			throw new McpError(ErrorCode.InvalidParams, `Output validation error: Invalid structured content for tool ${toolName}: ${errorMessage}`);
		}
	}
	/**
	* Executes a tool handler (either regular or task-based).
	*/
	async executeToolHandler(tool, args, extra) {
		const handler = tool.handler;
		if ("createTask" in handler) {
			if (!extra.taskStore) throw new Error("No task store provided.");
			const taskExtra = {
				...extra,
				taskStore: extra.taskStore
			};
			if (tool.inputSchema) {
				const typedHandler = handler;
				return await Promise.resolve(typedHandler.createTask(args, taskExtra));
			} else {
				const typedHandler = handler;
				return await Promise.resolve(typedHandler.createTask(taskExtra));
			}
		}
		if (tool.inputSchema) {
			const typedHandler = handler;
			return await Promise.resolve(typedHandler(args, extra));
		} else {
			const typedHandler = handler;
			return await Promise.resolve(typedHandler(extra));
		}
	}
	/**
	* Handles automatic task polling for tools with taskSupport 'optional'.
	*/
	async handleAutomaticTaskPolling(tool, request, extra) {
		if (!extra.taskStore) throw new Error("No task store provided for task-capable tool.");
		const args = await this.validateToolInput(tool, request.params.arguments, request.params.name);
		const handler = tool.handler;
		const taskExtra = {
			...extra,
			taskStore: extra.taskStore
		};
		const createTaskResult = args ? await Promise.resolve(handler.createTask(args, taskExtra)) : await Promise.resolve(handler.createTask(taskExtra));
		const taskId = createTaskResult.task.taskId;
		let task = createTaskResult.task;
		const pollInterval = task.pollInterval ?? 5e3;
		while (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled") {
			await new Promise((resolve) => setTimeout(resolve, pollInterval));
			const updatedTask = await extra.taskStore.getTask(taskId);
			if (!updatedTask) throw new McpError(ErrorCode.InternalError, `Task ${taskId} not found during polling`);
			task = updatedTask;
		}
		return await extra.taskStore.getTaskResult(taskId);
	}
	setCompletionRequestHandler() {
		if (this._completionHandlerInitialized) return;
		this.server.assertCanSetRequestHandler(getMethodValue(CompleteRequestSchema));
		this.server.registerCapabilities({ completions: {} });
		this.server.setRequestHandler(CompleteRequestSchema, async (request) => {
			switch (request.params.ref.type) {
				case "ref/prompt":
					assertCompleteRequestPrompt(request);
					return this.handlePromptCompletion(request, request.params.ref);
				case "ref/resource":
					assertCompleteRequestResourceTemplate(request);
					return this.handleResourceCompletion(request, request.params.ref);
				default: throw new McpError(ErrorCode.InvalidParams, `Invalid completion reference: ${request.params.ref}`);
			}
		});
		this._completionHandlerInitialized = true;
	}
	async handlePromptCompletion(request, ref) {
		const prompt = this._registeredPrompts[ref.name];
		if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Prompt ${ref.name} not found`);
		if (!prompt.enabled) throw new McpError(ErrorCode.InvalidParams, `Prompt ${ref.name} disabled`);
		if (!prompt.argsSchema) return EMPTY_COMPLETION_RESULT;
		const field = getObjectShape(prompt.argsSchema)?.[request.params.argument.name];
		if (!isCompletable(field)) return EMPTY_COMPLETION_RESULT;
		const completer = getCompleter(field);
		if (!completer) return EMPTY_COMPLETION_RESULT;
		return createCompletionResult(await completer(request.params.argument.value, request.params.context));
	}
	async handleResourceCompletion(request, ref) {
		const template = Object.values(this._registeredResourceTemplates).find((t) => t.resourceTemplate.uriTemplate.toString() === ref.uri);
		if (!template) {
			if (this._registeredResources[ref.uri]) return EMPTY_COMPLETION_RESULT;
			throw new McpError(ErrorCode.InvalidParams, `Resource template ${request.params.ref.uri} not found`);
		}
		const completer = template.resourceTemplate.completeCallback(request.params.argument.name);
		if (!completer) return EMPTY_COMPLETION_RESULT;
		return createCompletionResult(await completer(request.params.argument.value, request.params.context));
	}
	setResourceRequestHandlers() {
		if (this._resourceHandlersInitialized) return;
		this.server.assertCanSetRequestHandler(getMethodValue(ListResourcesRequestSchema));
		this.server.assertCanSetRequestHandler(getMethodValue(ListResourceTemplatesRequestSchema));
		this.server.assertCanSetRequestHandler(getMethodValue(ReadResourceRequestSchema));
		this.server.registerCapabilities({ resources: { listChanged: true } });
		this.server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
			const resources = Object.entries(this._registeredResources).filter(([_, resource]) => resource.enabled).map(([uri, resource]) => ({
				uri,
				name: resource.name,
				...resource.metadata
			}));
			const templateResources = [];
			for (const template of Object.values(this._registeredResourceTemplates)) {
				if (!template.resourceTemplate.listCallback) continue;
				const result = await template.resourceTemplate.listCallback(extra);
				for (const resource of result.resources) templateResources.push({
					...template.metadata,
					...resource
				});
			}
			return { resources: [...resources, ...templateResources] };
		});
		this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
			return { resourceTemplates: Object.entries(this._registeredResourceTemplates).map(([name, template]) => ({
				name,
				uriTemplate: template.resourceTemplate.uriTemplate.toString(),
				...template.metadata
			})) };
		});
		this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
			const uri = new URL(request.params.uri);
			const resource = this._registeredResources[uri.toString()];
			if (resource) {
				if (!resource.enabled) throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} disabled`);
				return resource.readCallback(uri, extra);
			}
			for (const template of Object.values(this._registeredResourceTemplates)) {
				const variables = template.resourceTemplate.uriTemplate.match(uri.toString());
				if (variables) return template.readCallback(uri, variables, extra);
			}
			throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} not found`);
		});
		this._resourceHandlersInitialized = true;
	}
	setPromptRequestHandlers() {
		if (this._promptHandlersInitialized) return;
		this.server.assertCanSetRequestHandler(getMethodValue(ListPromptsRequestSchema));
		this.server.assertCanSetRequestHandler(getMethodValue(GetPromptRequestSchema));
		this.server.registerCapabilities({ prompts: { listChanged: true } });
		this.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: Object.entries(this._registeredPrompts).filter(([, prompt]) => prompt.enabled).map(([name, prompt]) => {
			return {
				name,
				title: prompt.title,
				description: prompt.description,
				arguments: prompt.argsSchema ? promptArgumentsFromSchema(prompt.argsSchema) : void 0
			};
		}) }));
		this.server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
			const prompt = this._registeredPrompts[request.params.name];
			if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Prompt ${request.params.name} not found`);
			if (!prompt.enabled) throw new McpError(ErrorCode.InvalidParams, `Prompt ${request.params.name} disabled`);
			if (prompt.argsSchema) {
				const argsObj = normalizeObjectSchema(prompt.argsSchema);
				const parseResult = await safeParseAsync(argsObj, request.params.arguments);
				if (!parseResult.success) {
					const error = "error" in parseResult ? parseResult.error : "Unknown error";
					const errorMessage = getParseErrorMessage(error);
					throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for prompt ${request.params.name}: ${errorMessage}`);
				}
				const args = parseResult.data;
				const cb = prompt.callback;
				return await Promise.resolve(cb(args, extra));
			} else {
				const cb = prompt.callback;
				return await Promise.resolve(cb(extra));
			}
		});
		this._promptHandlersInitialized = true;
	}
	resource(name, uriOrTemplate, ...rest) {
		let metadata;
		if (typeof rest[0] === "object") metadata = rest.shift();
		const readCallback = rest[0];
		if (typeof uriOrTemplate === "string") {
			if (this._registeredResources[uriOrTemplate]) throw new Error(`Resource ${uriOrTemplate} is already registered`);
			const registeredResource = this._createRegisteredResource(name, void 0, uriOrTemplate, metadata, readCallback);
			this.setResourceRequestHandlers();
			this.sendResourceListChanged();
			return registeredResource;
		} else {
			if (this._registeredResourceTemplates[name]) throw new Error(`Resource template ${name} is already registered`);
			const registeredResourceTemplate = this._createRegisteredResourceTemplate(name, void 0, uriOrTemplate, metadata, readCallback);
			this.setResourceRequestHandlers();
			this.sendResourceListChanged();
			return registeredResourceTemplate;
		}
	}
	registerResource(name, uriOrTemplate, config, readCallback) {
		if (typeof uriOrTemplate === "string") {
			if (this._registeredResources[uriOrTemplate]) throw new Error(`Resource ${uriOrTemplate} is already registered`);
			const registeredResource = this._createRegisteredResource(name, config.title, uriOrTemplate, config, readCallback);
			this.setResourceRequestHandlers();
			this.sendResourceListChanged();
			return registeredResource;
		} else {
			if (this._registeredResourceTemplates[name]) throw new Error(`Resource template ${name} is already registered`);
			const registeredResourceTemplate = this._createRegisteredResourceTemplate(name, config.title, uriOrTemplate, config, readCallback);
			this.setResourceRequestHandlers();
			this.sendResourceListChanged();
			return registeredResourceTemplate;
		}
	}
	_createRegisteredResource(name, title, uri, metadata, readCallback) {
		const registeredResource = {
			name,
			title,
			metadata,
			readCallback,
			enabled: true,
			disable: () => registeredResource.update({ enabled: false }),
			enable: () => registeredResource.update({ enabled: true }),
			remove: () => registeredResource.update({ uri: null }),
			update: (updates) => {
				if (typeof updates.uri !== "undefined" && updates.uri !== uri) {
					delete this._registeredResources[uri];
					if (updates.uri) this._registeredResources[updates.uri] = registeredResource;
				}
				if (typeof updates.name !== "undefined") registeredResource.name = updates.name;
				if (typeof updates.title !== "undefined") registeredResource.title = updates.title;
				if (typeof updates.metadata !== "undefined") registeredResource.metadata = updates.metadata;
				if (typeof updates.callback !== "undefined") registeredResource.readCallback = updates.callback;
				if (typeof updates.enabled !== "undefined") registeredResource.enabled = updates.enabled;
				this.sendResourceListChanged();
			}
		};
		this._registeredResources[uri] = registeredResource;
		return registeredResource;
	}
	_createRegisteredResourceTemplate(name, title, template, metadata, readCallback) {
		const registeredResourceTemplate = {
			resourceTemplate: template,
			title,
			metadata,
			readCallback,
			enabled: true,
			disable: () => registeredResourceTemplate.update({ enabled: false }),
			enable: () => registeredResourceTemplate.update({ enabled: true }),
			remove: () => registeredResourceTemplate.update({ name: null }),
			update: (updates) => {
				if (typeof updates.name !== "undefined" && updates.name !== name) {
					delete this._registeredResourceTemplates[name];
					if (updates.name) this._registeredResourceTemplates[updates.name] = registeredResourceTemplate;
				}
				if (typeof updates.title !== "undefined") registeredResourceTemplate.title = updates.title;
				if (typeof updates.template !== "undefined") registeredResourceTemplate.resourceTemplate = updates.template;
				if (typeof updates.metadata !== "undefined") registeredResourceTemplate.metadata = updates.metadata;
				if (typeof updates.callback !== "undefined") registeredResourceTemplate.readCallback = updates.callback;
				if (typeof updates.enabled !== "undefined") registeredResourceTemplate.enabled = updates.enabled;
				this.sendResourceListChanged();
			}
		};
		this._registeredResourceTemplates[name] = registeredResourceTemplate;
		const variableNames = template.uriTemplate.variableNames;
		if (Array.isArray(variableNames) && variableNames.some((v) => !!template.completeCallback(v))) this.setCompletionRequestHandler();
		return registeredResourceTemplate;
	}
	_createRegisteredPrompt(name, title, description, argsSchema, callback) {
		const registeredPrompt = {
			title,
			description,
			argsSchema: argsSchema === void 0 ? void 0 : objectFromShape(argsSchema),
			callback,
			enabled: true,
			disable: () => registeredPrompt.update({ enabled: false }),
			enable: () => registeredPrompt.update({ enabled: true }),
			remove: () => registeredPrompt.update({ name: null }),
			update: (updates) => {
				if (typeof updates.name !== "undefined" && updates.name !== name) {
					delete this._registeredPrompts[name];
					if (updates.name) this._registeredPrompts[updates.name] = registeredPrompt;
				}
				if (typeof updates.title !== "undefined") registeredPrompt.title = updates.title;
				if (typeof updates.description !== "undefined") registeredPrompt.description = updates.description;
				if (typeof updates.argsSchema !== "undefined") registeredPrompt.argsSchema = objectFromShape(updates.argsSchema);
				if (typeof updates.callback !== "undefined") registeredPrompt.callback = updates.callback;
				if (typeof updates.enabled !== "undefined") registeredPrompt.enabled = updates.enabled;
				this.sendPromptListChanged();
			}
		};
		this._registeredPrompts[name] = registeredPrompt;
		if (argsSchema) {
			if (Object.values(argsSchema).some((field) => {
				const inner = field instanceof ZodOptional ? field._def?.innerType : field;
				return isCompletable(inner);
			})) this.setCompletionRequestHandler();
		}
		return registeredPrompt;
	}
	_createRegisteredTool(name, title, description, inputSchema, outputSchema, annotations, execution, _meta, handler) {
		validateAndWarnToolName(name);
		const registeredTool = {
			title,
			description,
			inputSchema: getZodSchemaObject(inputSchema),
			outputSchema: getZodSchemaObject(outputSchema),
			annotations,
			execution,
			_meta,
			handler,
			enabled: true,
			disable: () => registeredTool.update({ enabled: false }),
			enable: () => registeredTool.update({ enabled: true }),
			remove: () => registeredTool.update({ name: null }),
			update: (updates) => {
				if (typeof updates.name !== "undefined" && updates.name !== name) {
					if (typeof updates.name === "string") validateAndWarnToolName(updates.name);
					delete this._registeredTools[name];
					if (updates.name) this._registeredTools[updates.name] = registeredTool;
				}
				if (typeof updates.title !== "undefined") registeredTool.title = updates.title;
				if (typeof updates.description !== "undefined") registeredTool.description = updates.description;
				if (typeof updates.paramsSchema !== "undefined") registeredTool.inputSchema = objectFromShape(updates.paramsSchema);
				if (typeof updates.outputSchema !== "undefined") registeredTool.outputSchema = objectFromShape(updates.outputSchema);
				if (typeof updates.callback !== "undefined") registeredTool.handler = updates.callback;
				if (typeof updates.annotations !== "undefined") registeredTool.annotations = updates.annotations;
				if (typeof updates._meta !== "undefined") registeredTool._meta = updates._meta;
				if (typeof updates.enabled !== "undefined") registeredTool.enabled = updates.enabled;
				this.sendToolListChanged();
			}
		};
		this._registeredTools[name] = registeredTool;
		this.setToolRequestHandlers();
		this.sendToolListChanged();
		return registeredTool;
	}
	/**
	* tool() implementation. Parses arguments passed to overrides defined above.
	*/
	tool(name, ...rest) {
		if (this._registeredTools[name]) throw new Error(`Tool ${name} is already registered`);
		let description;
		let inputSchema;
		let outputSchema;
		let annotations;
		if (typeof rest[0] === "string") description = rest.shift();
		if (rest.length > 1) {
			const firstArg = rest[0];
			if (isZodRawShapeCompat(firstArg)) {
				inputSchema = rest.shift();
				if (rest.length > 1 && typeof rest[0] === "object" && rest[0] !== null && !isZodRawShapeCompat(rest[0])) annotations = rest.shift();
			} else if (typeof firstArg === "object" && firstArg !== null) {
				if (Object.values(firstArg).some((v) => typeof v === "object" && v !== null)) throw new Error(`Tool ${name} expected a Zod schema or ToolAnnotations, but received an unrecognized object`);
				annotations = rest.shift();
			}
		}
		const callback = rest[0];
		return this._createRegisteredTool(name, void 0, description, inputSchema, outputSchema, annotations, { taskSupport: "forbidden" }, void 0, callback);
	}
	/**
	* Registers a tool with a config object and callback.
	*/
	registerTool(name, config, cb) {
		if (this._registeredTools[name]) throw new Error(`Tool ${name} is already registered`);
		const { title, description, inputSchema, outputSchema, annotations, _meta } = config;
		return this._createRegisteredTool(name, title, description, inputSchema, outputSchema, annotations, { taskSupport: "forbidden" }, _meta, cb);
	}
	prompt(name, ...rest) {
		if (this._registeredPrompts[name]) throw new Error(`Prompt ${name} is already registered`);
		let description;
		if (typeof rest[0] === "string") description = rest.shift();
		let argsSchema;
		if (rest.length > 1) argsSchema = rest.shift();
		const cb = rest[0];
		const registeredPrompt = this._createRegisteredPrompt(name, void 0, description, argsSchema, cb);
		this.setPromptRequestHandlers();
		this.sendPromptListChanged();
		return registeredPrompt;
	}
	/**
	* Registers a prompt with a config object and callback.
	*/
	registerPrompt(name, config, cb) {
		if (this._registeredPrompts[name]) throw new Error(`Prompt ${name} is already registered`);
		const { title, description, argsSchema } = config;
		const registeredPrompt = this._createRegisteredPrompt(name, title, description, argsSchema, cb);
		this.setPromptRequestHandlers();
		this.sendPromptListChanged();
		return registeredPrompt;
	}
	/**
	* Checks if the server is connected to a transport.
	* @returns True if the server is connected
	*/
	isConnected() {
		return this.server.transport !== void 0;
	}
	/**
	* Sends a logging message to the client, if connected.
	* Note: You only need to send the parameters object, not the entire JSON RPC message
	* @see LoggingMessageNotification
	* @param params
	* @param sessionId optional for stateless and backward compatibility
	*/
	async sendLoggingMessage(params, sessionId) {
		return this.server.sendLoggingMessage(params, sessionId);
	}
	/**
	* Sends a resource list changed event to the client, if connected.
	*/
	sendResourceListChanged() {
		if (this.isConnected()) this.server.sendResourceListChanged();
	}
	/**
	* Sends a tool list changed event to the client, if connected.
	*/
	sendToolListChanged() {
		if (this.isConnected()) this.server.sendToolListChanged();
	}
	/**
	* Sends a prompt list changed event to the client, if connected.
	*/
	sendPromptListChanged() {
		if (this.isConnected()) this.server.sendPromptListChanged();
	}
};
const EMPTY_OBJECT_JSON_SCHEMA = {
	type: "object",
	properties: {}
};
/**
* Checks if a value looks like a Zod schema by checking for parse/safeParse methods.
*/
function isZodTypeLike(value) {
	return value !== null && typeof value === "object" && "parse" in value && typeof value.parse === "function" && "safeParse" in value && typeof value.safeParse === "function";
}
/**
* Checks if an object is a Zod schema instance (v3 or v4).
*
* Zod schemas have internal markers:
* - v3: `_def` property
* - v4: `_zod` property
*
* This includes transformed schemas like z.preprocess(), z.transform(), z.pipe().
*/
function isZodSchemaInstance(obj) {
	return "_def" in obj || "_zod" in obj || isZodTypeLike(obj);
}
/**
* Checks if an object is a "raw shape" - a plain object where values are Zod schemas.
*
* Raw shapes are used as shorthand: `{ name: z.string() }` instead of `z.object({ name: z.string() })`.
*
* IMPORTANT: This must NOT match actual Zod schema instances (like z.preprocess, z.pipe),
* which have internal properties that could be mistaken for schema values.
*/
function isZodRawShapeCompat(obj) {
	if (typeof obj !== "object" || obj === null) return false;
	if (isZodSchemaInstance(obj)) return false;
	if (Object.keys(obj).length === 0) return true;
	return Object.values(obj).some(isZodTypeLike);
}
/**
* Converts a provided Zod schema to a Zod object if it is a ZodRawShapeCompat,
* otherwise returns the schema as is. Throws if the value is not a valid Zod schema.
*/
function getZodSchemaObject(schema) {
	if (!schema) return;
	if (isZodRawShapeCompat(schema)) return objectFromShape(schema);
	if (!isZodSchemaInstance(schema)) throw new Error("inputSchema must be a Zod schema or raw shape, received an unrecognized object");
	return schema;
}
function promptArgumentsFromSchema(schema) {
	const shape = getObjectShape(schema);
	if (!shape) return [];
	return Object.entries(shape).map(([name, field]) => {
		return {
			name,
			description: getSchemaDescription(field),
			required: !isSchemaOptional(field)
		};
	});
}
function getMethodValue(schema) {
	const methodSchema = getObjectShape(schema)?.method;
	if (!methodSchema) throw new Error("Schema is missing a method literal");
	const value = getLiteralValue(methodSchema);
	if (typeof value === "string") return value;
	throw new Error("Schema method literal must be a string");
}
function createCompletionResult(suggestions) {
	return { completion: {
		values: suggestions.slice(0, 100),
		total: suggestions.length,
		hasMore: suggestions.length > 100
	} };
}
const EMPTY_COMPLETION_RESULT = { completion: {
	values: [],
	hasMore: false
} };

//#endregion
export { McpServer };