//#region node_modules/zod-to-json-schema/dist/esm/getRelativePath.js
const getRelativePath = (pathA, pathB) => {
	let i = 0;
	for (; i < pathA.length && i < pathB.length; i++) if (pathA[i] !== pathB[i]) break;
	return [(pathA.length - i).toString(), ...pathB.slice(i)].join("/");
};

//#endregion
export { getRelativePath };