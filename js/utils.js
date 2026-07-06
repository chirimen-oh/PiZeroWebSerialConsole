export const sleep = (msec) =>
	new Promise((resolve) => setTimeout(resolve, msec));

export function arrayBufferToBase64(buffer) {
	let binary = "";
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return window.btoa(binary);
}

export function base64ToArrayBuffer(base64) {
	const binary_string = window.atob(base64);
	const len = binary_string.length;
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i++) {
		bytes[i] = binary_string.charCodeAt(i);
	}
	return bytes.buffer;
}

export function escapePath(path) {
	const str = String(path);
	// 安全な文字だけならエスケープ不要(そのまま使える)
	if (/^[A-Za-z0-9._-]+$/.test(str)) {
		return str;
	}
	// フォールバック: Bash ANSI-C Quoting
	const jsonString = JSON.stringify(str);
	return jsonString.replace(/^"/, `$$'`).replace(/"$/, `'`);
}

export function pad2(inp) {
	return ("0" + inp).slice(-2);
}

export function getOutputLines(str) {
	return str.split("\n").map((line) => line.trim());
}

const textFileExtensions = [
	".txt",
	".sh",
	".csv",
	".tsv",
	".js",
	".conf",
	".mjs",
	".md",
	".yml",
	".xml",
	".html",
	".htm",
	".json",
	".py",
	".php",
];

export function isTextFile(path) {
	const fname = path.substring(path.lastIndexOf("/"));
	const f_ext = fname.substring(fname.lastIndexOf("."));
	const f_name = fname.substring(0, fname.lastIndexOf("."));
	if (f_name === "") return true;
	return textFileExtensions.includes(f_ext);
}
