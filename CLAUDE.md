# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

`~/.claude/projects/**/*.jsonl`（Claude Code のセッション履歴）と `ps`（稼働プロセス）を
読み取り、複数の Claude Code セッションを 1 画面で俯瞰するローカルダッシュボード。
**依存パッケージゼロ・Node 単体で動作**（package.json も存在しない）。

## 起動

```bash
node server.mjs           # → http://localhost:4317
PORT=8080 node server.mjs # ポート変更
```

ビルド・テスト・lint の仕組みは無い。`node server.mjs` で起動して動作確認する。

## アーキテクチャ

2 ファイル構成。サーバが Claude のログを解析して JSON で返し、フロントが 3 秒ごとに描画する。

- **[server.mjs](server.mjs)** — HTTP サーバ + 解析ロジック。3 つのレスポンスを返す:
  - `GET /api/sessions` — 全プロジェクトのセッション一覧スナップショット（`buildSnapshot`）
  - `GET /api/session?project=&id=` — 1 セッションの会話タイムライン全文（`buildSessionDetail`）
  - 静的ファイル（`public/` 配下）
- **[public/index.html](public/index.html)** — UI 全部入り（HTML/CSS/JS を 1 ファイルに同梱）。
  `setInterval(tick, 3000)` で `/api/sessions` をポーリングし、カードをクリックすると
  `/api/session` でモーダルに会話詳細を表示。

### セッション状態判定（mtime ベース）

ファイルの最終更新時刻からの経過で状態を決める（[server.mjs:18-21](server.mjs#L18)）:

| 状態 | 条件 |
|------|------|
| `active` 🟢 稼働中 | 90 秒以内に更新（`ACTIVE_MS`） |
| `idle` 🟡 待機中 | 30 分以内（`IDLE_MS`） |
| `dormant` ⚪ 休眠 | それ以前 |

`PARSE_WINDOW_MS`（36h）より古いセッションは詳細解析せず、メタ情報のみの軽量表示にする
（[server.mjs:141](server.mjs#L141)）。

### jsonl 解析のキモ

- セッション jsonl は肥大化しうるため**全文を読まない**。一覧用は末尾 256KB（`readTail`）+
  先頭 64KB（`readHead`、タイトル/初回プロンプトの取りこぼし防止）だけを読む。
  詳細表示は全文、ただし 2MB 超は末尾 2MB に制限。
- `parseLines` は途中で切れた行（末尾読みで発生）を try/catch で握りつぶす前提。
  `{` で始まらない行・パース失敗行は黙って捨てる。
- 解析対象のエントリ種別: `ai-title`（タイトル）, `last-prompt`（最後の指示）,
  `e.cwd` / `e.gitBranch`、`message.role` が `user`/`assistant` のもの。
- プロセス突合: `ps` から `native-binary/claude` かつ `--output-format` を含む行を抽出し
  （[server.mjs:92-93](server.mjs#L92)）、`--resume <uuid>` のセッション ID に `resumed` バッジを付与。

## 注意点

- `/api/session` は `project`/`id` にパス区切り文字が含まれるリクエストを 400 で弾く
  （ディレクトリトラバーサル対策、[server.mjs:318](server.mjs#L318)）。解析対象パスを
  いじる際はこのバリデーションを壊さないこと。
- `decodeProjectDir` はプロジェクトディレクトリ名（`-Users-masa-work-foo`）を
  `/Users/masa/work/foo` に**推定変換**するだけ。元パスにハイフンが含まれると不正確になる
  表示専用ロジック（[server.mjs:79](server.mjs#L79)）。
