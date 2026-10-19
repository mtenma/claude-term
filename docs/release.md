# リリース手順(アプリの更新)

新しい版を出すと、各 Mac の Claude Term(0.1.9 以降)は、次に起動したときに「アップデートのお知らせ」を出します。［今すぐ更新］を押すと、新しい版をダウンロードして確かめ、Claude Term を終了して入れ替え、新しい版で開き直します。

- 置き場所: このリポジトリ `mtenma/claude-term` の Releases(公開)
- 流れ: タグ `v<版>` を push → GitHub Actions(`.github/workflows/release.yml`)が Mac でビルド → 署名 → Releases に公開
- アプリが見る URL: `https://github.com/mtenma/claude-term/releases/latest/download/latest-mac.json`
- Apple Silicon の Mac だけ。Apple の開発者の署名(Developer ID)はしていません(ad-hoc 署名)
- 同じ仕組みの手本: ryukyu-yayoi(`~/Documents/琉球本舗データ/仕訳確認アプリ/macos/リリース手順.md`)、tomari(`docs/guide/リリース手順.md`)

| 項目 | ryukyu-yayoi・tomari | claude-term |
|---|---|---|
| 配布の置き場所 | 配布専用の公開リポジトリ(ソースは private) | ソースと同じ公開リポジトリ |
| 公開に使う権限 | 個人のアクセストークン `RELEASES_TOKEN`(期限 1 年) | `GITHUB_TOKEN`(トークンの作成と期限切れが無い) |
| 署名の鍵の Secret | リポジトリの Secret | **環境 `release` の Secret**(`v*` のタグからだけ使える) |
| Actions の分数 | private の無料枠を使う | 公開リポジトリなので無料。代わりに実行の記録は誰でも見られる |
| 載せるもの | インストーラ・ZIP と latest.json | zip・DMG・latest-mac.json |
| 試しのビルド | 無い | Actions の画面の［Run workflow］(署名と公開はしない) |

---

## 1. 一度だけの準備

### 1.1 署名の鍵を作る

ターミナルで、このリポジトリのフォルダから流します。

```bash
node scripts/release.mjs keygen ~/.claude-term-release/update.key
```

- `~/.claude-term-release/update.key`(秘密鍵。本人だけが読める権限 600)と `update.key.pub`(公開鍵)ができ、画面に公開鍵が出ます。
- リポジトリの中や git の作業ツリーの中には作りません。ファイルがもうあると止まり、上書きしません。
- **作り直すと、配った版は自動で更新できなくなります**(作り直すのは、なくしたときだけ。9. を見てください)。

出てきた公開鍵を `src/main/updateKey.ts` に書きます(Claude に「公開鍵はこれ」と渡して頼んでもかまいません)。

```ts
export const UPDATE_PUBLIC_KEYS: readonly string[] = ['<出てきた公開鍵>']
```

| ファイル | 中身 | 扱い |
|---|---|---|
| `~/.claude-term-release/update.key` | 秘密鍵 | **秘密**。git に入れない。画面写真に撮らない |
| `~/.claude-term-release/update.key.pub` | 公開鍵 | `src/main/updateKey.ts` に書いてある(公開してよい) |

### 1.2 環境 `release` を作り、秘密鍵を入れる

署名の鍵は、`v` で始まるタグからの実行だけが読めるように、環境 `release` の Secret に入れます(ブランチからの実行や試しのビルドからは見えません)。

**画面で行う場合**

1. https://github.com/mtenma/claude-term/settings/environments を開き、［New environment］を押します。
2. Name に `release` と入れて［Configure environment］。
3. 「Deployment branches and tags」で［No restriction］を［**Selected branches and tags**］に変えます。
4. ［Add deployment branch or tag rule］→ Ref type を **Tag** にし、Name pattern に `v*` と入れて［Add rule］。
5. 「Required reviewers」などほかの項目は付けません(2026-10-19 に決めたこと)。
6. 秘密鍵はターミナルから入れます(画面に出さずに入れるため)。

   ```bash
   gh secret set UPDATE_SIGNING_KEY --env release -R mtenma/claude-term < ~/.claude-term-release/update.key
   ```

**ターミナルだけで行う場合**(上の 1〜5 と同じこと)

```bash
gh api -X PUT repos/mtenma/claude-term/environments/release --input - <<'EOF'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
EOF
gh api -X POST repos/mtenma/claude-term/environments/release/deployment-branch-policies -f name='v*' -f type=tag
gh secret set UPDATE_SIGNING_KEY --env release -R mtenma/claude-term < ~/.claude-term-release/update.key
```

### 1.3 控えを取る

`update.key` と `update.key.pub` を、パスワード管理ソフトなど、この Mac の外にも置きます。秘密鍵をなくすと、配った Mac は自動で更新できなくなり、すべての Mac で手で入れ直すことになります(tomari・ryukyu-yayoi の鍵と一緒に控えると忘れません)。

### 1.4 確かめ

```bash
gh secret list --env release -R mtenma/claude-term
gh api repos/mtenma/claude-term/environments/release/deployment-branch-policies --jq '.branch_policies[] | [.type, .name]'
```

`UPDATE_SIGNING_KEY` と `["tag","v*"]` が出れば OK です。

### 1.5 試しのビルド

`release.yml` が main に入ってから行えます(GitHub は、既定のブランチにある workflow だけを［Run workflow］で動かせます)。試しのビルドも `package.json` の版の変更の内容(`docs/releases/<版>.txt`)を確かめるので、2.2 の 2・3(版を上げる、変更の内容を書く)を済ませて main に入れてから流します。

- 画面: https://github.com/mtenma/claude-term/actions/workflows/release.yml →［Run workflow］→ Branch は `main` →［Run workflow］
- ターミナル: `gh workflow run release.yml -R mtenma/claude-term --ref main`

build のジョブだけが動き、署名と公開はしません。緑になれば、ビルド・テスト・パッケージ・配る zip の確かめまで通っています。作った物を見たいときは:

```bash
gh run list -R mtenma/claude-term --workflow release.yml --limit 3
gh run download <ID> -R mtenma/claude-term -n bundle -D dist-test/ci-bundle
```

---

## 2. リリースのしかた(毎回)

### 2.1 全体の流れ

```text
（Mac）版を上げる・変更の内容を書く → main に入れる → main の最新にタグ v<版> を打って push
   ↓ 自動（GitHub Actions）
build（Mac）: 確かめ → npm ci → 型の検査・スモーク → パッケージ → パッケージの検査 → zip と DMG
   ↓
sign（Ubuntu、環境 release）: zip を計算し直す → 秘密鍵で署名 → 公開鍵で確かめる → latest-mac.json
   ↓
publish（Ubuntu）: main に入っているかを見る → 下書きで載せる → Latest(main に入っていないときはプレリリース)で公開
   ↓
（各 Mac）Claude Term を起動 →「アップデートのお知らせ」→［今すぐ更新］→ 入れ替わって開き直す
```

### 2.2 手順

例: `0.1.10` を出す。

1. **main を最新にする**

   ```bash
   git switch main && git pull --ff-only && git status
   ```

2. **版を上げる**(`package.json` と `package-lock.json` が一緒に変わります)

   ```bash
   npm version 0.1.10 --no-git-tag-version
   ```

   - 形は `<数>.<数>.<数>`。出すたびに上げます。同じ番号で出し直しても、入れた人には届きません。
3. **変更の内容を書く**: `docs/releases/0.1.10.txt`(6. の書き方)
4. **手元で確かめる**(Actions の最初の段と同じ確かめと、主なテスト)

   ```bash
   node scripts/release.mjs check v0.1.10
   npm run check && npm run smoke && node scripts/smoke-hooks.mjs && node scripts/smoke-update.mjs
   ```

   「版 0.1.10: タグ・package.json・package-lock.json・変更の内容 OK」と出れば OK です。
5. **コミットして main に入れる**

   ```bash
   git add package.json package-lock.json docs/releases/0.1.10.txt
   git commit -m "0.1.10 を出す"
   git push origin main
   ```

   - 作業ブランチで作り、プルリクエストで main に入れてもかまいません。
6. **main の最新にタグを打って push**(これでリリースが始まります)

   ```bash
   git fetch origin
   git tag v0.1.10 origin/main
   git push origin v0.1.10
   ```

   - タグは 1 本ずつ push します(一度に 4 本以上 push すると、GitHub は Actions を始めません)。
   - ブランチを先に push してから、タグを push します(タグのコミットに `release.yml` が無いと、何も始まらず、エラーも出ません)。
7. **進み具合を見る**

   ```bash
   gh run list -R mtenma/claude-term --workflow release.yml --limit 3
   gh run watch <ID> -R mtenma/claude-term --exit-status
   ```

   画面なら https://github.com/mtenma/claude-term/actions
8. **確かめる**

   ```bash
   gh release view v0.1.10 -R mtenma/claude-term
   gh release download v0.1.10 -R mtenma/claude-term -p latest-mac.json -p '*-mac.zip' -D dist-test/release-check
   node scripts/release.mjs verify dist-test/release-check/latest-mac.json dist-test/release-check/Claude-Term-0.1.10-arm64-mac.zip
   rm -rf dist-test/release-check
   ```

   Latest で、ファイルが 3 つ(zip・DMG・latest-mac.json)あり、「署名 OK、zip OK」と出れば、各 Mac の Claude Term は次に起動したときにお知らせを出します。最後に、自分の Mac で Claude Term を起動し直して、更新されることを確かめます。

---

## 3. Actions の中で起きること

| ジョブ | 段 | 内容 | 止まる条件 |
|---|---|---|---|
| build(Mac、鍵なし) | 版と変更の内容を確かめる | タグの形、`package.json`・`package-lock.json` の版、`docs/releases/<版>.txt` の形 | 版が違う・変更の内容が無いか形が違う |
| | 依存を入れる | `npm ci` | |
| | 型の検査とスモーク | `npm run check`、`npm run smoke`、`smoke-hooks`・`smoke-usage`・`smoke-update` | テストの失敗 |
| | パッケージにする・検査 | `npm run package`、`smoke-mac-package.mjs`(署名・UUID・PTY・コスト画面) | |
| | 配る zip と DMG を作る | アプリの名札・版・署名、ネットから来た印が無いこと、検査用の版でないこと、公開鍵が `updateKey.ts` と同じこと。zip(ditto)の名前が英数字だけ | 公開鍵が無い・違う、検査用の版 |
| sign(Ubuntu、環境 release) | 署名する | zip の大きさと SHA-256 を計算し直し、秘密鍵で署名し、`updateKey.ts` の公開鍵で確かめてから `latest-mac.json` とリリースの説明を作る | 秘密鍵が無い・鍵の組が違う、zip が build のものと違う |
| publish(Ubuntu) | main に入っている版かを確かめる | 作ったコミットが main の先頭と同じか、その祖先か | |
| | リリースする | 下書きで載せてから公開。main に入っていれば Latest、入っていなければプレリリース | |

---

## 4. うまくいかないとき

| 症状 | 原因と直し方 |
|---|---|
| タグを push しても Actions が始まらない | タグのコミットに `release.yml` があるか。ブランチを先に push したか。タグを 4 本以上まとめて push していないか |
| build が「タグの版 … と package.json の版 … が違います」「変更の内容 … がありません」で止まる | **まだ公開していないので**、タグを打ち直します: `git tag -d v0.1.10 && git push origin :refs/tags/v0.1.10` → 直してコミット・push → 2.2 の 6 から |
| build のテストやパッケージで止まる | 記録を見て直し、上と同じくタグを打ち直します。Actions の機械のたまたまの失敗なら、タグはそのままで［Re-run failed jobs］ |
| sign が「秘密鍵 … がないか、形が違います」「公開鍵で確かめられません」で止まる | 1.2 の Secret を入れ直します(`updateKey.ts` の公開鍵と組になっている秘密鍵か)。タグはそのままで［Re-run failed jobs］ |
| publish で止まる | 下書きが残っていれば消してから［Re-run failed jobs］: `gh release list -R mtenma/claude-term` → `gh release delete v0.1.10 -R mtenma/claude-term --yes`(タグは消さない) |
| **公開した後で問題が見つかった** | その版の番号は二度と使いません。広がりを止めるには、前の Latest に戻すか、その版の `latest-mac.json` を消します: `gh release delete-asset v0.1.10 latest-mac.json -R mtenma/claude-term --yes`(Latest に `latest-mac.json` が無いと、アプリは何も出しません)。直した版を新しい番号で出します |
| 利用者の Mac で「更新できませんでした」 | お知らせの窓の文を見ます。「この場所のアプリは自動で入れ替えられません」なら、「アプリケーション」フォルダに置いて開き直すか、DMG で手で入れます(7.)。「ほかにも Claude Term が起動しています」なら、ほかを終了します |
| お知らせが出ない | その Mac のブラウザで https://github.com/mtenma/claude-term/releases/latest/download/latest-mac.json が開けるか。開けなければ、お知らせも出ません(ターミナルはそのまま使えます)。`npm start` の開発版は確かめません |
| 更新のあと、フォルダへのアクセスなどを聞かれる | ［許可］を押します。ad-hoc 署名のため、版が変わると聞き直されることがあります。フルディスクアクセスなどは、黙って外れることがあるので、［システム設定］→［プライバシーとセキュリティ］で入れ直します |
| アプリが見つからない(入れ替えと戻しの両方に失敗した) | 元の版が `~/Library/Application Support/Claude Term/updates/<版>/previous/Claude Term.app` にあります。Finder で「アプリケーション」フォルダへ移します |

---

## 5. main に入れる前に試す(プレリリース)

1. 作業ブランチで版を上げてコミットし、作業ブランチを push してから、そのコミットにタグを打って push します(2.2 の 2〜4・6。タグは `origin/main` ではなく作業ブランチのコミットに打つ)。
2. **プレリリース**として公開されます。Latest ではないので、各 Mac には知らされません。
3. 試す Mac で、Claude Term を ⌘Q で終了してから、次のように開きます。お知らせが出たら［今すぐ更新］。

   ```bash
   open -a "Claude Term" --args --update-feed \
     https://github.com/mtenma/claude-term/releases/download/v<版>/latest-mac.json
   ```

   - `--update-feed` に渡せるのは、このリポジトリのリリースの URL だけです。署名は必ず確かめます。
4. 試してよければ、main に入れたうえで、その版を正式(Latest)にします。

   ```bash
   gh release edit v<版> -R mtenma/claude-term --prerelease=false --latest
   ```

   - main で直しが入ったときは、試した版は使わず、版を上げて main から出し直します。

---

## 6. 変更の内容の書き方

`docs/releases/<版>.txt` は、お知らせの窓(文字のまま)とリリースのページ(Markdown)の両方にそのまま出ます。署名の対象なので、`check` で次を確かめます。

- UTF-8(BOM なし)・LF。`.gitattributes` で LF に固定しています
- 1 項目 1 行の `- ` の箇条書きか、ふつうの文。使う人が読む日本語で書きます
- 行頭の `#`、`@`、`` ` ``、`<` は使わない(2 か所で見た目が変わる、通知やリンクになるため)
- 2,000 字まで
- お知らせを何版か飛ばした人には、最新の版の内容だけが出ます

---

## 7. 最初の配布と、手で入れる手順

更新の仕組みが入った最初の版(0.1.9)は、手で入れます。それ以降は自動です。自動で入れ替えられないときも、この手順で入れます。

1. Claude Term を終了します。
2. https://github.com/mtenma/claude-term/releases/latest から `Claude-Term-<版>-arm64.dmg` をダウンロードして開き、`Claude Term.app` を「アプリケーション」フォルダへ入れ替えます。
3. 一度だけ次を実行してから起動します(ad-hoc 署名のため)。

   ```bash
   xattr -cr "/Applications/Claude Term.app"
   ```

---

## 8. 開発のときの注意

- `npm start`(開発版)は、更新を確かめに行きません。
- 手元で `npm run package` して `/Applications` に入れた版は、確かめに行きます(GitHub の版のほうが新しければ、お知らせが出ます)。
- 更新の確かめの通信は、起動時に `latest-mac.json` を 1 回取るだけです。保存しない通信を使い、cookie やキャッシュは残しません。User-Agent に版は入れません。
- **bundle ID `jp.sabira.claude-term` と公開鍵は変えない**(変えると更新が届かなくなります)。
- 実際のパッケージで更新を最後まで通す検査: `node scripts/smoke-update-package.mjs`(数分。検査用の bundle ID と userData を `dist-test` に作り、`/Applications` と普段の設定には触れません)。検査用の版(`scripts/build.mjs --update-test`)は配らない・`/Applications` に入れない。`release.mjs bundle` は検査用の版を見つけると止まります。
- 0.1.9 を入れた後、最初の自動更新(0.1.10)で、`/Applications` の中で入れ替わることを実機で確かめます。ad-hoc 署名のアプリに macOS の「アプリの管理」の保護がかかるかは、まだ確かめていません(ryukyu-yayoi では通りました)。

---

## 9. 鍵をなくした・漏れたとき

- **漏れた疑い**: 新しい鍵を作り(`keygen` で別のファイルに)、新しい公開鍵を `updateKey.ts` の配列に**足した**版を、古い鍵で署名して出します。行き渡ったら、Secret を新しい鍵に替え、古い公開鍵を外した版を出します。まだ更新していない Mac では古い鍵が効き続けます。
- **なくした**: 配った Mac は自動で更新できなくなります。新しい鍵で版を出し、各 Mac で 7. の手順で手で入れてもらいます。
- 実行の記録に鍵の値が出てしまったときは、その実行の記録を消し(Actions の画面の［Delete all logs］)、上の「漏れた疑い」の手順で鍵を替えます。
