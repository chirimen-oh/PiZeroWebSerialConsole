/**
 * 拡張型シリアル通信マネージャー (Vanilla JS / ブラウザ標準 API 準拠)
 * * 【特徴】
 * 1. Web Serial API のロック管理を安全に行う try-finally 設計
 * 2. 同時実行を防ぐ FIFO コマンドキュー搭載
 * 3. EventTarget 継承によるネイティブイベント駆動
 * 4. 外部から監視ルールを追加できるプラグイン・アーキテクチャ
 */
export class SerialManager extends EventTarget {
	constructor() {
		super(); // EventTarget の初期化
		
		this.port = null;
		this.reader = null;
		this.writer = null;
		this.isConnecting = false;
		this.receiveBuffer = "";
		this.currentWaiter = null;
		this.onDataReceived = null; // ターミナル描画用のフック

		// --- 追加: キュー管理用の変数 ---
		this.queue = [];             // 実行待ちのコマンドを格納するキュー
		this.isProcessingQueue = false; // 現在キューを消化中かどうかのフラグ
		
		// 拡張イベント監視用の変数
		this.evtBuf = "";   // ストリーム解析用バッファ
		this.watchers = {}; // 登録されたウォッチャー（プラグイン）の格納庫
	}

	/**
	 * 外部から「イベント名」と「監視ロジック」を登録する
	 * @param {string} eventName - 発火させるカスタムイベント名
	 * @param {Object} watcherConfig - parse({ lines, buffer }) を持つオブジェクト
	 */
	addWatcher(eventName, watcherConfig) {
		this.watchers[eventName] = watcherConfig;
	}
	
	
	/**
	 * シリアルポートへの接続を開始する
	 */
	async connect(baudRate = 115200) {
		// 既に接続(オープン)済みなら再オープンしない。
		// ログイン失敗時の autoLogInPiZero(true) 再試行で再びここに来ると
		// "InvalidStateError: The port is already open." になり、
		// さらにポート選択ダイアログが再表示されてしまうのを防ぐ。
		if (this.port && this.port.readable) {
			return;
		}
		this.port = await navigator.serial.requestPort();
		await this.port.open({ baudRate });
		this.isConnecting = true;
		this.startReadLoop();
	}

	/**
	 * 接続を切断し、待機タスクをクリーンアップする
	 */
	async disconnect() {
		this.isConnecting = false;

		// 1. 現在結果を待機中のタスクがあれば、タイムアウトを待たずに強制キャンセル
		if (this.currentWaiter) {
			clearTimeout(this.currentWaiter.timeoutId);
			if (this.currentWaiter.reject) {
				this.currentWaiter.reject(new Error("Connection closed."));
			}
			this.currentWaiter = null;
		}

		// 2. キューに溜まっている未実行のタスクをすべて破棄し、エラーを返す
		while (this.queue.length > 0) {
			const task = this.queue.shift();
			task.reject(new Error("Connection closed. Command canceled."));
		}
		this.isProcessingQueue = false;

		// リーダーの安全なキャンセルとロック解放 ---
		if (this.reader) {
			try {
				await this.reader.cancel(); // 読み取りループを強制終了させる
			} catch (e) {
				console.warn("Reader cancel error:", e);
			}
		}
		
		// 既存の切断処理
		try {
			await this.write(" ");
			await new Promise((resolve) => setTimeout(resolve, 10)); // tiny sleep
		} catch (e) {
			console.warn("Dummy write failed during disconnect:", e);
		}

		// ポートのクローズ
		try {
			if (this.port) {
				await this.port.close();
				this.port = null;
			}
		} catch (e) {
			console.warn("Error during port closing:", e);
		}
	}

	/**
	 * データをシリアルポートへ直接書き込む（低レベルメソッド）
	 */
	async write(data) {
		if (!this.port) return;
		const encoder = new TextEncoder();
		this.writer = this.port.writable.getWriter();
		try {
			await this.writer.write(encoder.encode(data));
		} finally {
			this.writer.releaseLock();
		}
	}

	/**
	 * 外部から呼ばれるコマンド実行メソッド（キューに積まれて順番に実行される）
	 */
	async writeAndWaitFor(data, expectedRegExp, timeoutMs = 30000) {
		return new Promise((resolve, reject) => {
			// タスクをキューの末尾に追加
			this.queue.push({ data, expectedRegExp, timeoutMs, resolve, reject });
			// キューの消化を開始（既に実行中ならそのまま無視される）
			this.processQueue();
		});
	}

	/**
	 * キューを FIFO で順番に消化する内部メソッド
	 */
	async processQueue() {
		// 既に処理中、またはキューが空なら何もしない
		if (this.isProcessingQueue || this.queue.length === 0) return;
		
		this.isProcessingQueue = true;
		
		// キューの先頭からタスクを取り出す（FIFO）
		const task = this.queue.shift();

		try {
			// 実際の通信処理を実行（プロンプトが返るまでここで待機される）
			const result = await this._executeCommand(task.data, task.expectedRegExp, task.timeoutMs);
			task.resolve(result); // 呼び出し元（awaitしている箇所）へ結果を返す
		} catch (error) {
			task.reject(error);   // タイムアウトなどのエラーを返す
		} finally {
			this.isProcessingQueue = false;
			// 次のタスクがあれば再帰的に処理を開始
			this.processQueue();
		}
	}

	// 実際の通信待機処理（旧 writeAndWaitFor の中身） ---
	_executeCommand(data, expectedRegExp, timeoutMs) {
		// 次のコマンド出力と混ざらないよう、実行直前にバッファをクリア
		this.receiveBuffer = "";

		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.currentWaiter = null;
				reject(new Error(`Timeout waiting for: ${expectedRegExp}`));
			}, timeoutMs);

			// checkWaiter() で判定するための設定を保持
			this.currentWaiter = {
				regex:
					typeof expectedRegExp === "string"
						? new RegExp(expectedRegExp)
						: expectedRegExp,
				resolve, // ここが呼ばれると _executeCommand の Promise が解決される
				reject, // 切断時に強制キャンセルできるように reject を保持
				timeoutId,
			};

			// 非同期処理のエラーは .catch() で拾ってreject する
			this.write(data).catch((error) => {
				clearTimeout(timeoutId);
				this.currentWaiter = null;
				reject(error);
			});
		});
	}

	/**
	 * バックグラウンドでデータを読み込み続けるメインループ
	 */
	async startReadLoop() {
		try {
			while (this.port && this.port.readable && this.isConnecting) {
				this.reader = this.port.readable.getReader();
				try {
					while (this.isConnecting) {
						// disconnect() 内で reader.cancel() が呼ばれると、done: true で抜ける
						const { value, done } = await this.reader.read();
						if (done) break;

						if (value) {
							const decoded = new TextDecoder("utf-8").decode(value);

							// ターミナルへ即時描画
							if (this.onDataReceived) this.onDataReceived(decoded);

							this.receiveBuffer += decoded;
							this.checkWaiter(); // 受信のたびに待機条件を満たしたかチェック
							
							// 常時監視イベント用の解析処理へデータを流す
							this._parseStream(decoded);
						}
					}
				} catch (e) {
					console.warn("Read error:", e);
				} finally {
					// cancel() やエラーで抜けた後、確実にロックを解放する
					if (this.reader) {
						this.reader.releaseLock();
						this.reader = null;
					}
				}
			}
		} catch (error) {
			console.error("Read loop fatal error:", error);
		}
	}

	/**
	 * 常時流れてくるストリームを解析し、登録されたウォッチャーを走らせる
	 */
	_parseStream(chunk) {
		this.evtBuf += chunk;
		let lines = this.evtBuf.split(/\r?\n/);
		this.evtBuf = lines.pop() || ""; // 未確定の末尾（プロンプトなど）をバッファに残す

		// ウォッチャーが扱いやすいよう「制御文字なし・トリム済み」のデータを用意
		const cleanLines = lines.map(line => this.removeControlChars(line).trim());
		const cleanBuffer = this.removeControlChars(this.evtBuf);

		// 登録されているすべてのウォッチャーにデータを分配して実行
		for (const [eventName, watcher] of Object.entries(this.watchers)) {
			const detail = watcher.parse({ lines: cleanLines, buffer: cleanBuffer });

			// ウォッチャーから解析結果（undefined 以外）が返ってきたら、カスタムイベントを発火！
			if (detail !== undefined) {
				this.dispatchEvent(new CustomEvent(eventName, { detail }));
			}
		}
	}

	/**
	 * 従来の await 判定用チェックメソッド
	 */
	checkWaiter() {
		if (!this.currentWaiter) return;

		const { regex, resolve, timeoutId } = this.currentWaiter;
		if (this.receiveBuffer.match(regex)) {
			clearTimeout(timeoutId);
			const result = this.removeControlChars(this.receiveBuffer);
			this.receiveBuffer = "";     // 次の待機のためにクリア
			this.currentWaiter = null;   // 待機状態を解除
			resolve(result);             // _executeCommand の待機を解除
		}
	}

	/**
	 * ターミナルの装飾文字（ANSI エスケープシーケンス）を除去するユーティリティ
	 */
	removeControlChars(str) {
		return str.replace(
			/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
			""
		);
	}
}
