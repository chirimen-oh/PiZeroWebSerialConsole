# SerialManager API Reference

`SerialManager` は、ブラウザの Web Serial API をラップし、シリアル通信における「コマンド実行同期（Queue / Promise）」と「常時ログ監視（Plugin / EventDriven）」のハイブリッド制御を提供する Vanilla JS コンポーネントです。

* **継承:** `EventTarget`
* **モジュールタイプ:** ES Modules (`export class`)

---

## 🛠️ コンストラクタ (Constructor)

### `new SerialManager()`
インスタンスを初期化し、内部キュー、ストリームバッファ、およびプラグイン（ウォッチャー）格納庫を生成します。

```javascript
const serial = new SerialManager();
```

---

## 📥 パブリックプロパティ / フック (Properties & Hooks)

### `onDataReceived`
* **型:** `Function | null`
* **説明:** シリアルポートからデータを受信した瞬間に、**生の文字列（チャンク）**がそのまま渡されるコールバックフックです。内部バッファやプロンプト判定ロジックとは完全に分離されているため、ターミナル（xterm.jsなど）への即時描画・ライブ表示専用の経路として使用します。

```javascript
serial.onDataReceived = (decodedChunk) => {
    terminal.write(decodedChunk); // ターミナルへ即時出力
};
```

---

## ⚙️ メソッド (Methods)

### `async connect(baudRate = 115200)`
シリアルポートの選択ダイアログを表示し、接続を確立してバックグラウンドでの読み込みループを開始します。
* **引数:**
  * `baudRate` *(number, 任意)*: 通信速度。デフォルトは `115200`。
* **戻り値:** `Promise<void>`
* **注意点:** 既にポートがオープンされている（`this.port.readable` が有効な）場合は、二重オープンエラーやダイアログの再表示を防ぐために処理を自動スキップします。

---

### `async disconnect()`
接続を安全に切断し、すべての内部状態とリソースを確実に解放します。
* **戻り値:** `Promise<void>`
* **内部処理:**
  1. 現在 `await` で結果待機中のタスクを強制キャンセル（`Error: Connection closed.` を返却）。
  2. キューに溜まっている未実行の全タスクを破棄。
  3. `reader` のロックを安全に解放し、物理ポートをクローズ。

---

### `async write(data)`
シリアルポートへデータを直接書き込む低レベルメソッドです。
* **引数:**
  * `data` *(string)*: 送信する文字列。
* **戻り値:** `Promise<void>`
* **注意点:** 排他制御（キューイング）を行わないため、アプリケーション層から直接呼び出すのではなく、基本的には内部処理、または緊急のシグナル送信等でのみ使用してください。

---

### `async writeAndWaitFor(data, expectedRegExp, timeoutMs = 30000)`
コマンドを送信し、シリアル側から**期待するレスポンスが返ってくるまで非同期で待機**します。
* **引数:**
  * `data` *(string)*: 送信するコマンド文字列（通常は末尾に `\n` が必要）。
  * `expectedRegExp` *(string | RegExp)*: 待機条件となる正規表現または文字列。
  * `timeoutMs` *(number, 任意)*: タイムアウトミリ秒。デフォルトは `30000`（30秒）。
* **戻り値:** `Promise<string>` (制御文字が除去された、受信バッファ全体の文字列)
* **アーキテクチャ特徴:** 本メソッドは内部の **FIFO（先入れ先出し）キュー** に自動的に積まれます。手前のコマンドが完了またはタイムアウトするまで次のコマンドは実行されないため、非同期通信の衝突（Race Condition）を完全に回避します。

---

### `addWatcher(eventName, watcherConfig)`
常時流れてくる受信ストリームを監視する**プラグイン**（**ウォッチャー**）を登録します。
* **引数:**
  * `eventName` *(string)*: 解析条件に合致した際に発火させるカスタムイベント名。
  * `watcherConfig` *(Object)*: 後述の「ウォッチャーインターフェース」を満たすオブジェクト。

```javascript
serial.addWatcher("myevent", {
    parse({ lines, buffer }) { /* 解析ロジック */ }
});
```

---

## 🔌 ウォッチャーインターフェース仕様 (Watcher Interface)

`addWatcher` に渡すオブジェクトは、必ず以下の `parse` メソッドを実装している必要があります。オブジェクト内に独自のプロパティを定義することで、**RxJSの `scan` オペレータのように内部状態（State）を自律保持することが可能**です。

### `parse({ lines, buffer })`
* **引数:**
  * `lines` *(string[])*: 前回のパース以降に「新しく確定した行」の配列。ANSIエスケープシーケンス（制御文字）は除去済み、前後の空白はトリム済み。
  * `buffer` *(string)*: 未確定の末尾（改行待ちのプロンプトなど）を含む、現在の最新受信文字バッファ。制御文字除去済み.
* **戻り値:**
  * `any`: 条件に合致し、上流へ通知したいデータ。**返却したデータがそのまま `CustomEvent.detail` に格納されます。**
  * `undefined`: 条件に合致しない、または解析途中の場合。`undefined` を返すとイベントは発火しません（RxJSの `filter` 相当）。

---

## 🔔 発火するカスタムイベント (Custom Events)

`EventTarget` を継承しているため、標準の `addEventListener` でイベントを購読します。データは `event.detail` から取得します。

### 1. `dirchange` イベント
ラズパイのコンソール上でカレントディレクトリ（パス）が変更された、またはコマンド実行が完了してプロンプトに戻った際に発火します。
* **`event.detail`:** `string` (現在の絶対パスまたは相対パス。例: `"/etc"` , `"~/myApp"`)

### 2. `filelist` イベント
ユーザーまたはプログラムが `ls -al` を実行し、その出力結果（ファイル一覧）がすべて出揃ってプロンプトに戻った瞬間に発火します。
* **`event.detail`:** `string[]` (行ごとの文字列配列。`ls -al` のエコーバック行や Linux の `合計 xxx` サマリー行は自動で除外されます)

```javascript
// イベントハンドリングの例
serial.addEventListener("dirchange", (e) => {
    console.log("Path:", e.detail); 
});

serial.addEventListener("filelist", (e) => {
    console.log("Files:", e.detail); // ['drwxr-xr-x ...', '-rw-r--r-- ...']
});
```

---

## 🛠️ ユーティリティメソッド (Utility)

### `removeControlChars(str)`
文字列に含まれる ANSI エスケープシーケンス（ターミナルの文字色変更やカーソル移動コードなど）を正規表現で一括除去します。ウォッチャー内部や `checkWaiter` でテキストマッチングを正確に行うために内部で自動使用されています。
* **引数:** `str` *(string)*
* **戻り値:** `string`


---

## 📚 参考情報: Angular / RxJS 概念とのマッピング対比

本モジュールは、外部ライブラリ（RxJS）や大規模フレームワーク（Angular）に依存することなく、その高度な設計思想（リアクティブ・ストリームと排他制御）を Vanilla JS のブラウザ標準 API のみで再現しています。開発チーム内での設計思想の共有として、以下に主要な概念のマッピングを記載します。

### 1. ストリーム処理とオペレータのマッピング

| Angular / RxJS の手法・概念 | 本クラスにおける Vanilla JS での解決策・対応箇所 |
| :--- | :--- |
| **Observable** <br>*(ストリームの源泉)* | **`startReadLoop()` と `TextDecoder`**<br>シリアルポートから時間経過とともに断続的に入ってくる生データ（チャンク）の流れ。 |
| **`.pipe()`** <br>*(パイプライン結合)* | **`_parseStream(chunk)` メソッド**<br>生のチャンクを受け取り、行単位の配列（`cleanLines`）や未確定バッファ（`cleanBuffer`）へ整形した上で、各ウォッチャーへ一元的にデータを分配する共通の主導線。 |
| **`map` オペレータ** <br>*(データの変形・抽出)* | **ウォッチャー内の `parse()` からのデータ抽出、および `removeControlChars`**<br>生データから特定の正規表現でパスのみを抜き出して（変形して）上流へ返却する処理。 |
| **`filter` オペレータ** <br>*(データの選別・遮断)* | **ウォッチャー内の `return undefined;`**<br>解析条件に一致しない場合、`undefined` を返すことで後続のイベント発火処理を自動的にスキップ（遮断）する仕組み。 |
| **`scan` オペレータ** <br>*(状態の蓄積・維持)* | **ウォッチャーオブジェクト内に定義した内部変数（例: `lsBuf: null`）**<br>RxJSではアキュムレータを用いて関数型的に過去の状態を保持しますが、本クラスではJavaScript本来のオブジェクト指向特性を活かし、オブジェクト内のプライベート変数として状態（State）の蓄積とリセットを直感的に管理。 |
| **`Subject.next()`** <br>*(ストリームへのイベント投入)* | **`this.dispatchEvent()`**<br>ブラウザ標準のイベント駆動システム。解析が確定した瞬間に、ネイティブなカスタムイベントを生成して上位層へ自律的にプッシュ（通知）する。 |
| **`.subscribe()`** <br>*(ストリームの購読)* | **`serial.addEventListener()`**<br>流れてきたイベント（データ）を受け取り、UIの更新やファイルマネージャへのデータ流し込みなど、非同期的な連鎖処理を実行するエンドポイント。 |

### 2. 並行処理・非同期制御のマッピング

| Angular / RxJS の手法・概念 | 本クラスにおける Vanilla JS での解決策・対応箇所 |
| :--- | :--- |
| **`concatMap`** / **`exhaustMap`**<br>*(キューイングと非同期の直列化)* | **`this.queue`（配列） と `processQueue()` による再帰ループ**<br>非同期のコマンド通信（Promise）を内部配列にスタックし、1つのタスクが完了（`resolve`）またはタイムアウト（`reject`）するまで次のタスクを絶対に実行させない排他制御。これにより、ハードウェア（Raspberry Pi）が処理しきれないデータの衝突（Race Condition）を構造的に排除。 |