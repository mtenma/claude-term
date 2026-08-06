# Claude Term

Claude Code 用途に特化したターミナルアプリ。デスクトップがターミナルウィンドウだらけになる問題を、**1ウィンドウ = メイン表示 + セッションカード一覧** で解決します。

- 左: メインターミナル(フル表示)
- 右: 起動中セッションのカード一覧(画面末尾5行のプレビュー付き)
- カードの枠色でセッション状態が一目で分かる:

| 状態 | 枠色 | 意味 |
|---|---|---|
| 実行中 | 緑 | Claude Code が処理中(または出力が流れている) |
| 承認待ち | オレンジ(点滅) | ツール承認や入力待ちで止まっている。**見るべき** |
| 待機 | グレー | プロンプトに戻って静止している |
| 終了 | 暗色 | シェルが終了した |

カードをクリックするとそのセッションがメインにフル表示され、裏のセッションも動き続けます。「＋ new」は素の zsh ログインシェルを即座に開きます。`cd` での移動や `claude` / `codex` の起動は通常のターミナルと同じように自分でコマンドを打ちます。

## 起動方法

```sh
npm install
npm start
```

## Claude Code の状態検知(hooks 連携)

「承認待ち=オレンジ」を正確に検知するため、初回起動時に同意ダイアログを出した上で `~/.claude/settings.json` に **ガード付き hooks(6件)** を追記します。

- 追記されるコマンドはすべて次の形式です(`# claude-term-state-hook` マーカー付き):

  ```sh
  [ -n "$CLAUDE_TERM_PORT" ] && curl -s -m 1 -X POST "http://127.0.0.1:$CLAUDE_TERM_PORT/state/$CLAUDE_TERM_SESSION/<state>" >/dev/null 2>&1 || true # claude-term-state-hook
  ```

- `CLAUDE_TERM_PORT` は Claude Term のセッション内にだけ存在する環境変数です。**通常のターミナル(iTerm2 等)で claude を使うときは何も実行されません**(ガードで no-op)。
- 対象イベント: `UserPromptSubmit` / `PreToolUse` / `PostToolUse` → 実行中、`Notification`(permission_prompt|idle_prompt)→ 承認待ち、`Stop` → 待機、`SessionEnd` → 検知解除
- 書換え前の内容は `~/.claude/settings.json.backup-claude-term` に保存されます。

### 削除手順

`~/.claude/settings.json` から `claude-term-state-hook` を含む hook エントリを削除するだけです。同意をやり直したい場合はアプリの設定ファイル(`~/Library/Application Support/claude-term/config.json`)の `hooksConsent` を消してください。

hooks を追記しない場合もアプリは動作します(出力の有無による実行中/待機の判定と、ターミナルベルによる要注目検知のみになります)。

## 開発

```sh
npm run check   # 型検査
npm run smoke   # SessionManager のスモークテスト(GUI 不要・attach 切替の欠落/重複ゼロを機械検証)
CLAUDE_TERM_SCREENSHOT=/tmp/s.png CLAUDE_TERM_DEMO=states npm run shot  # 自動スクリーンショット
```

### アーキテクチャ概要

- Electron + node-pty + xterm.js。メインプロセスが全セッションの PTY を保持し、各セッションに `@xterm/headless` のミラー端末を並走させる(VS Code のターミナル復元と同じ構成)
- カード切替時は `@xterm/addon-serialize` のスナップショットを renderer に送って xterm を復元し、以後はそのセッションの生データのみ転送
- 全 PTY はメイン表示の cols/rows に常時揃えるため、切替時に再折返し崩れが起きない

## 既知の制限

- プレビューはテキストのみ(色は反映されない)
- Codex は通常のコマンドとして動作するが、状態検知は出力ヒューリスティックのみ(hooks 連携は Claude Code のみ)
- 配布パッケージ(.app)は未対応。`npm start` で起動する
