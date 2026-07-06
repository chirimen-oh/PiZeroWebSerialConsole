import {
	sleep,
	escapePath,
	arrayBufferToBase64,
	base64ToArrayBuffer,
	getOutputLines,
} from "./utils.js";

export class FileManager {
	constructor(serialManager, cmdPrompt) {
		this.serial = serialManager;
		this.cmdPrompt = cmdPrompt;
		this.isTransferring = false;
		this.haltRequested = false;
	}

	haltTransfer() {
		if (this.isTransferring) {
			this.haltRequested = true;
		}
	}

	async cd(dir) {
		const cdStr = dir ? ` cd -- ${escapePath(dir)}` : " cd --";
		await this.serial.writeAndWaitFor(cdStr + "\n", this.cmdPrompt);
		return await this.pwd();
	}

	async pwd() {
		const ret = getOutputLines(
			await this.serial.writeAndWaitFor(" pwd\n", this.cmdPrompt)
		);
		// プロンプトからカレントディレクトリを抽出
		const promptStr = ret[ret.length - 1].trim();
		return promptStr.substring(
			promptStr.lastIndexOf(":") + 1,
			promptStr.lastIndexOf("$")
		);
	}

	async lsal() {
		const capturingRegex =
			/^(?<attr>\S+)\s+(?<hlinks>\S+)\s+(?<group>\S+)\s+(?<user>\S+)\s+(?<size>\S+)\s+(?<month>\S+)\s+(?<date>\S+)\s+(?<time>\S+)\s+(?<name>.+)$/;
		const rawRet = await this.serial.writeAndWaitFor(
			" ls -al --quoting-style=c\n",
			this.cmdPrompt
		);
		const ret = getOutputLines(rawRet);

		const files = [];
		const prompt = ret[ret.length - 1].trim();

		for (let i = 2; i < ret.length - 1; i++) {
			const match = capturingRegex.exec(ret[i]);
			if (!match) continue;

			const fileInfo = { dir: match.groups.attr[0] === "d", ...match.groups };
			try {
				let nameField = fileInfo.name ?? '""';
				if (nameField.includes(" -> ")) nameField = nameField.split(" -> ")[0];
				fileInfo.name = JSON.parse(nameField);
			} catch {
				fileInfo.name = "";
			}
			files.push(fileInfo);
		}
		return { files, prompt };
	}

	async rm(fileName) {
		await this.serial.writeAndWaitFor(
			` rm -- ${escapePath(fileName)}\n`,
			this.cmdPrompt
		);
	}

	async getFile(path, onProgress) {
		if (this.isTransferring) return null;

		this.isTransferring = true;
		this.haltRequested = false;
		let accumulatedOutput = "";

		try {
			await this.serial.write("\x03"); // ctrl+c
			await sleep(100);

			// プロンプトの残飯を完全にクリア
			this.serial.receiveBuffer = ""; 

			// エコー文字列に誤反応しないよう、ENDとLINEを分割してechoさせるハック
			const cmd = ` base64 -- ${escapePath(path)} | if [ 12 -le $(cat /etc/debian_version | cut -d. -f1) ]; then more --exit-on-eof -50; else more -50; fi; echo "END""LINE"`;
			
			// 【修正】writeAndWaitFor の「戻り値」に、出力されたデータがすべて入ってくる
			let chunk = await this.serial.writeAndWaitFor(cmd + "\n", /--More--|ENDLINE/);
			
			while (true) {
				if (this.haltRequested) {
					await this.serial.writeAndWaitFor("q", this.cmdPrompt);
					break;
				}

				// 取得した文字列を蓄積
				accumulatedOutput += chunk;

				// ENDLINE が含まれていれば最終行まで読み込み完了
				if (chunk.includes("ENDLINE")) {
					break;
				}

				if (onProgress) onProgress(accumulatedOutput.length);
				
				await sleep(5);
				// まだ続く場合はスペースを送って次のページを要求
				chunk = await this.serial.writeAndWaitFor(" ", /--More--|ENDLINE/);
			}

			// コマンド終了後、確実にプロンプトへ戻るのを待つ
			await this.serial.writeAndWaitFor("\n", this.cmdPrompt);

		} catch (e) {
			console.error("File download failed", e);
			return null;
		} finally {
			this.isTransferring = false;
		}

		// --- 受け取った生データからBase64文字列だけを綺麗に抽出する処理 ---
		let cleanBase64 = accumulatedOutput;
		
		// 1. 先頭に入り込んでいる「エコーされたコマンド文字列」を削る
		const echoStr = 'echo "END""LINE"';
		if (cleanBase64.includes(echoStr)) {
			cleanBase64 = cleanBase64.substring(cleanBase64.lastIndexOf(echoStr) + echoStr.length);
		}

		// 2. 末尾の ENDLINE 以降を削る
		cleanBase64 = cleanBase64.split("ENDLINE")[0];

		// 3. 途中の --More-- や、改行・空白などの余計な文字をすべて消去する
		cleanBase64 = cleanBase64.replace(/--More--/g, "").replace(/\s+/g, "");

		// Base64として不正な文字が含まれていないか最終チェック
		if (!cleanBase64 || !/^[A-Za-z0-9+/=]+$/.test(cleanBase64)) {
			console.error("Invalid Base64 sequence captured.", cleanBase64);
			return null;
		}

		return base64ToArrayBuffer(cleanBase64);
	}

	async saveFile(buffer, fileName, onProgress) {
		if (this.isTransferring) return;

		this.isTransferring = true;
		this.haltRequested = false;

		try {
			const base64 = arrayBufferToBase64(buffer);
			const lineLength = 512;
			const totalChunks = Math.ceil(base64.length / lineLength);

			await this.serial.write("\x03");
			await sleep(100);
			await this.serial.writeAndWaitFor(
				` base64 -d > ${escapePath(fileName)}\n`,
				"\n"
			);

			for (let i = 0; i < totalChunks; i++) {
				if (this.haltRequested) break;

				const line = base64.substring(i * lineLength, (i + 1) * lineLength);
				await this.serial.writeAndWaitFor(line + "\n", "\n");
				await sleep(1);

				if (onProgress) onProgress(Math.floor((100 * i) / totalChunks));
			}

			await sleep(50);
			await this.serial.write("\x04"); // ctrl+d
			await sleep(10);
			await this.serial.write("\n");
			await sleep(10);
			await this.serial.writeAndWaitFor("\n", /\$ /);
		} finally {
			this.isTransferring = false;
		}
	}

	async mv(fromPath, toPath, bySudo) {
		const sudoHead = bySudo ? "sudo " : "";
		await this.serial.writeAndWaitFor(
			` ${sudoHead}mv -- ${escapePath(fromPath)} ${escapePath(toPath)}\n`,
			this.cmdPrompt
		);
	}

	async cp(fromPath, toPath, bySudo) {
		const sudoHead = bySudo ? "sudo " : "";
		await this.serial.writeAndWaitFor(
			` ${sudoHead}cp -- ${escapePath(fromPath)} ${escapePath(toPath)}\n`,
			this.cmdPrompt
		);
	}

	async wifiScan() {
		const rawRet = await this.serial.writeAndWaitFor(
			" sudo iwlist wlan0 scan\n",
			this.cmdPrompt
		);
		const ret = getOutputLines(rawRet);
		const wifiInfos = [];
		let wifiInfo = {};
		let first = true;
		for (let i = 1; i < ret.length - 1; i++) {
			let row = ret[i].split(/:/);
			if (ret[i].indexOf("Cell") >= 0 && ret[i].indexOf("Address") > 0) {
				row = ret[i].split(/\s+/);
				if (!first) {
					wifiInfos.push(wifiInfo);
				} else {
					first = false;
				}
				wifiInfo = { address: row[4] };
			} else if (ret[i].indexOf("ESSID:") >= 0) {
				wifiInfo.essid = row[1].trim().replaceAll('"', "");
			} else if (ret[i].indexOf("IEEE 802.11") >= 0) {
				wifiInfo.spec = row[1].trim();
			} else if (ret[i].indexOf("Quality") >= 0) {
				wifiInfo.quality = ret[i].trim();
			} else if (ret[i].indexOf("Group Cipher") >= 0) {
				wifiInfo.spec += "," + row[1].trim();
			} else if (ret[i].indexOf("Pairwise Ciphers") >= 0) {
				wifiInfo.spec += "," + row[1].trim();
			} else if (ret[i].indexOf("Authentication Suites") >= 0) {
				wifiInfo.spec += row[1].trim();
			} else if (ret[i].indexOf("Frequency:") >= 0) {
				wifiInfo.frequency = row[1].trim();
			} else if (ret[i].indexOf("Channel:") >= 0) {
				wifiInfo.channel = row[1].trim();
			}
		}
		wifiInfos.push(wifiInfo);
		return { rawData: ret, wifiInfos };
	}
}
