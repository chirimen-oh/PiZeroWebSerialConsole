import { SerialManager } from "./SerialManager.js";
import { FileManager } from "./FileManager.js";
import { sleep, pad2, isTextFile, getOutputLines, escapePath } from "./utils.js";

const cmdPrompt = "pi@raspberrypi:";
const loginId = "pi";
const loginPassword = "raspberry";
let currentDir = "";
let currentDirFiles = [];
let tempBinaryBuffer = null;

const FileManagerMessage = {
	ja: { move: "移動", view: "表示", edit: "編集", delete: "削除", do: "実行", run: "実行" },
	en: { move: "move", view: "view", edit: "edit", delete: "delete", do: "do", run: "run" },
};
const lang = navigator.language.startsWith("ja") ? "ja" : "en";

const serial = new SerialManager();
const fileManager = new FileManager(serial, cmdPrompt);
const term = new Terminal.Terminal();

const terminalEl = document.getElementById("terminal");
const connectBtn = document.getElementById("connectBtn");
const cmdBtns = document.getElementById("cmdBtns");
const currentDirSpan = document.getElementById("currentDirSpan");
const fileListTable = document.getElementById("fileListTable");
const progressSpan = document.getElementById("progress");
const fileNameInputUI = document.getElementById("fileNameInputUI");
const fileNameInput = document.getElementById("fileNameInput");

// FitAddonの初期化と適用
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

term.open(terminalEl);
fitAddon.fit(); // 初回描画時にサイズを合わせる

// ウィンドウのサイズ変更イベントを監視してターミナルをリサイズ
window.addEventListener('resize', () => {
	fitAddon.fit();
});

term.onData((data) => {
	serial.write(data);
});
serial.onDataReceived = (data) => {
	term.write(data);
};

// --- コネクション＆ログイン ---
async function autoLogInPiZero(noRetry = false) {
	await serial.connect();
	await sleep(100);
	term.writeln("<<CONNECTED>> Waiting prompt...");

	let hasResp = false;
	let ret;
	while (!hasResp) {
		try {
			await serial.write("\x03"); // ctrl+c
			ret = await serial.writeAndWaitFor("\n", ":", 1000);
			hasResp = true;
		} catch (e) {
			term.write(".");
			await sleep(1000);
		}
	}

	if (ret.indexOf("pi@") >= 0) {
		// 既にログイン済み(プロンプトが返ってきている)ので何もしない
	} else if (ret.indexOf("login:") >= 0) {
		await serial.writeAndWaitFor(`${loginId}\n`, "Password:");
		await serial.writeAndWaitFor(`${loginPassword}\n`, "\\$", 40000);
	} else if (!noRetry) {
		// 初回はプロンプト確定前の出力に ":" が引っかかり、login: でも pi@ でもない
		// 中途半端な応答を掴んでしまうことがある。その場合は一度だけやり直す。
		// （serial.connect() はオープン済みなら何もしないので再オープンされない）
		await autoLogInPiZero(true);
		return;
	} else {
		console.error("login fail...");
		return;
	}

	terminalEl.focus();
	await sleep(300);
	await serial.writeAndWaitFor(" HISTCONTROL=ignoreboth\n", cmdPrompt);

	if (lang === "ja") {
		await serial.writeAndWaitFor(
			" sudo timedatectl set-timezone Asia/Tokyo\n",
			cmdPrompt
		);
	}

	const date = new Date();
	const dateCmd = ` sudo date ${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}${date.getFullYear()}.${pad2(date.getSeconds())}`;
	await serial.writeAndWaitFor(`${dateCmd}\n`, cmdPrompt);

	currentDir = await fileManager.pwd();
	await fileManager.cd("");

	connectBtn.style.display = "none";
	cmdBtns.style.display = "";
	await renderFileList();
}

// --- ファイルリスト描画 ---
async function renderFileList() {
	while (fileListTable.firstChild)
		fileListTable.removeChild(fileListTable.firstChild);

	const lsFiles = await fileManager.lsal();
	currentDirFiles = lsFiles.files;
	
	currentDir = await fileManager.pwd();
	currentDirSpan.innerText = `📂 ${currentDir}`;

	const ul = document.createElement("ul");
	ul.className = "filelist";

	currentDirFiles.forEach((file) => {
		const li = document.createElement("li");
		let fsizeS = Number(file.size);
		if (fsizeS > 1024 * 1024)
			fsizeS = Math.floor((10 * fsizeS) / (1024 * 1024)) / 10 + "M";
		else if (fsizeS > 1024)
			fsizeS = Math.floor((10 * fsizeS) / 1024) / 10 + "K";
		
		const fnSpan = document.createElement("span");
		
		// ディレクトリかどうかでアイコン（絵文字）を分ける
		const icon = file.dir ? "📁" : "📄";
		// 必要であればディレクトリ名だけ太字にするなどのスタイルも当てられます
		const fw = file.dir ? "bold" : "normal";
		
		fnSpan.innerHTML = `<label title="${file.name} : ${fsizeS}bytes" style="font-weight: ${fw};">${icon} ${file.name}</label>`;
		li.appendChild(fnSpan);

		const actUl = document.createElement("ul");
		if (file.dir) {
			actUl.appendChild(
				createActionLi(FileManagerMessage[lang].move, async () => {
					await fileManager.cd(file.name);
					await renderFileList();
				})
			);
		} else {
			actUl.appendChild(
				createActionLi(FileManagerMessage[lang].view, () =>
					showFile(file.name, file.size, false)
				)
			);
			actUl.appendChild(
				createActionLi(FileManagerMessage[lang].edit, () =>
					showFile(file.name, file.size, true)
				)
			);

			const delLi = document.createElement("li");
			const delSpan = document.createElement("span");
			delSpan.innerText = FileManagerMessage[lang].delete;
			delLi.appendChild(delSpan);

			const delCfUl = document.createElement("ul");
			delCfUl.appendChild(createActionLi("-", () => {})); // 確認用ダミー
			delCfUl.appendChild(
				createActionLi(FileManagerMessage[lang].do, async () => {
					await fileManager.rm(file.name);
					await renderFileList();
				})
			);
			delLi.appendChild(delCfUl);
			actUl.appendChild(delLi);

			// .js ファイルにだけ「実行」を表示し、クリックで node 実行する
			if (file.name.toLowerCase().endsWith(".js")) {
				actUl.appendChild(
					createActionLi(FileManagerMessage[lang].run, () =>
						runJsFile(file.name)
					)
				);
			}
		}
		li.appendChild(actUl);
		ul.appendChild(li);
	});

	// 見栄え用の空行
	for (let i = 0; i < 3; i++) ul.appendChild(document.createElement("li"));
	fileListTable.appendChild(ul);
}

// .js ファイルをターミナルで node 実行する(出力はそのままターミナルへ流す)。
// 実行中のプロセスや入力中の行を ^C で中断してから実行することで、
// 何度押しても同じ結果になる(べき等)。先頭にスペースを付けないので
// シェル履歴(ログ)にコマンドが残る。
async function runJsFile(fileName) {
	await serial.write("\x03"); // ctrl+c
	await sleep(100);
	await serial.write(`node ${escapePath(fileName)}\n`);
}

function createActionLi(text, onClick) {
	const li = document.createElement("li");
	const span = document.createElement("span");
	span.innerText = text;
	span.onclick = onClick;
	li.appendChild(span);
	return li;
}

function existFile(fileName) {
	return currentDirFiles.some((fl) => fl.name === fileName);
}

// --- ファイル閲覧・編集・保存 ---
async function showFile(fileName, size, editFlg) {
	let ans = "";
	if (existFile(fileName) && size > 0) {
		progressSpan.innerHTML = `<span id='progressText'>Loading...</span> <input type='button' id='haltBtn' value='キャンセル' />`;
		document.getElementById("haltBtn").onclick = () =>
			fileManager.haltTransfer();

		ans = await fileManager.getFile(fileName, (len) => {
			// 厳密なプログレス計算が難しい場合はLoading表示で代替
			document.getElementById("progressText").innerText =
				`Loading: ${len} bytes`;
		});
		progressSpan.innerHTML = "";
	}

	if (ans !== null) {
		if (isTextFile(fileName) || typeof ans === "string") {
			const txtString =
				typeof ans === "string"
					? ans
					: new TextDecoder().decode(new Uint8Array(ans));
			const win = window.open(
				"MonacoEditorWindow.html",
				"textSourceWindow",
				"height=600,width=800"
			);

			const setEditorVal = async (val, flag, retryCount = 1) => {
				await sleep(100);
				
				// 現在のウィンドウオブジェクトの状態をコンソールに出力
				console.log(`[Attempt ${retryCount}] Polling Editor State:`, {
					winExists: !!win,
					winClosed: win.closed,
					editorExists: !!win.editor,
					editSrcExists: !!win.editSrc
				});

				if (win.editor && win.editSrc) {
					console.log("✅ Editor is ready! Loading text...");
					await sleep(500);
					console.log("Call editSrc command");
					win.editSrc(val, fileName, currentDir, flag);
				} else {
					console.warn("⏳ Editor not ready yet. Retrying...");
					// ★ここにawaitがないと一瞬で何千回もループしてスタックオーバーフローします
					await setEditorVal(val, flag, retryCount + 1); 
				}
			};
			
			console.log("Starting Editor polling...");
			await setEditorVal(txtString, editFlg);
		} else {
			const win = window.open("", "textSourceWindow", "height=500,width=500");
			tempBinaryBuffer = { name: fileName, buffer: ans };
			win.document.documentElement.innerHTML =
				`データはバイナリのようです 保存しますか？ : Size:${ans.byteLength} bytes<br>` +
				`<input type='button' value='save' onClick='window.opener.saveAsBinary()'></input>`;
		}
	}
}

// MonacoEditor等から呼ばれるグローバル関数群（windowにバインド）
window.saveAsBinary = function () {
	if (tempBinaryBuffer) {
		const blob = new Blob([tempBinaryBuffer.buffer], { type: "octet/stream" });
		const url = window.URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = tempBinaryBuffer.name;
		a.click();
		window.URL.revokeObjectURL(url);
	}
	tempBinaryBuffer = null;
};

window.setEditedText = async function (srcTxt, sourcePath) {
	if (sourcePath.dir === currentDir) {
		const buffer = new TextEncoder("utf-8").encode(srcTxt);
		progressSpan.innerHTML = `<span id='progressText'>Saving...</span>`;
		await fileManager.saveFile(buffer, sourcePath.fileName, () => {});
		progressSpan.innerHTML = "";
		await sleep(300);
		await renderFileList();
	} else {
		console.warn("カレントディレクトリが変更されています");
	}
};

// --- 新規テキスト作成 ---
function handleCreateNewTxt(stat) {
	if (stat === false) {
		fileNameInputUI.style.display = "none";
		fileNameInput.value = "";
	} else if (stat === true) {
		const fileName = fileNameInput.value;
		if (existFile(fileName)) {
			fileNameInput.value = "ERR: already exists.";
			setTimeout(() => {
				fileNameInput.value = "";
			}, 1000);
		} else {
			fileNameInput.value = "";
			fileNameInputUI.style.display = "none";
			showFile(fileName, 1, true); // 空ファイルとしてエディタを開く
		}
	} else {
		fileNameInputUI.style.display = "";
	}
}

// --- イベントリスナー ---
connectBtn.addEventListener("click", () => autoLogInPiZero());
document.getElementById("closeBtn").addEventListener("click", async () => {
	await serial.disconnect();
	connectBtn.style.display = "";
	cmdBtns.style.display = "none";
	term.writeln("\r\n<<CONNETCTION CLOSED>>");
});
document.getElementById("homeBtn").addEventListener("click", async () => {
	await fileManager.cd("");
	await renderFileList();
});
document.getElementById("lsBtn").addEventListener("click", renderFileList);
document
	.getElementById("wifiBtn")
	.addEventListener("click", () =>
		window.open("WiFiPanel.html", "wifiPanelWindow", "height=600,width=800")
	);
document
	.getElementById("chirimenBtn")
	.addEventListener("click", () =>
		window.open("chirimenPanel.html", "chirimenPanel", "height=650,width=800")
	);

document
	.getElementById("createTxtBtn")
	.addEventListener("click", () => handleCreateNewTxt());
document
	.getElementById("createTxtExecBtn")
	.addEventListener("click", () => handleCreateNewTxt(true));
document
	.getElementById("createTxtCancelBtn")
	.addEventListener("click", () => handleCreateNewTxt(false));

document.getElementById("fileUpl").addEventListener("change", (e) => {
	const file = e.target.files[0];
	if (!file) return;

	const fr = new FileReader();
	fr.onload = async (event) => {
		progressSpan.innerHTML = `<span id='progressText'>0%</span> <input type='button' id='haltBtn' value='キャンセル' />`;
		document.getElementById("haltBtn").onclick = () =>
			fileManager.haltTransfer();

		await fileManager.saveFile(event.target.result, file.name, (percent) => {
			document.getElementById("progressText").innerText =
				`${percent}% completed`;
		});

		e.target.value = "";
		progressSpan.innerHTML = "";
		await sleep(200);
		await renderFileList();
	};
	fr.readAsArrayBuffer(file);
});





// --- ここから下を追記（WiFiPanel用のインターフェース公開） ---
window.portWritelnWaitfor = (cmd, prompt, timeoutMs) => serial.writeAndWaitFor(cmd + "\n", prompt, timeoutMs);
window.getOutputLines = getOutputLines;
window.cmdPrompt = cmdPrompt;
window.str2arrayBuffer = (str) => new TextEncoder("utf-8").encode(str);
window.saveFile = (buffer, fileName) => fileManager.saveFile(buffer, fileName, () => {});
window.cp = (fromPath, toPath, bySudo) => fileManager.cp(fromPath, toPath, bySudo);

window.mv = (fromPath, toPath, bySudo) => fileManager.mv(fromPath, toPath, bySudo);
window.showDir = async () => await renderFileList();
window.lsal = async () => await fileManager.lsal();

window.closeConnection = async () => {
	await serial.disconnect();
	connectBtn.style.display = "";
	cmdBtns.style.display = "none";
	term.writeln("\r\n<<CONNETCTION CLOSED>>");
};