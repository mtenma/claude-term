import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs'

export function readJsonObject(filePath: string): {settings: Record<string, unknown>; raw: string | null} {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {settings: {}, raw: null}
    throw new Error(`${filePath} を読み込めません。ファイルのアクセス権を確認してください。`)
  }
  let settings: unknown
  try {
    settings = JSON.parse(raw)
  } catch {
    throw new Error(`${filePath} が正しい JSON ではないため、変更を中止しました。`)
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error(`${filePath} の最上位は JSON オブジェクトである必要があります。`)
  }
  return {settings: settings as Record<string, unknown>, raw}
}

export function writeAtomically(filePath: string, contents: string, mode = 0o600): void {
  // dotfiles 管理のリンク自体は置き換えず、従来の直接書込みと同じ参照先を更新する。
  const targetPath = fs.lstatSync(filePath, {throwIfNoEntry: false})?.isSymbolicLink()
    ? fs.realpathSync(filePath) : filePath
  const temporaryPath = `${targetPath}.tmp-${randomUUID()}`
  try {
    fs.writeFileSync(temporaryPath, contents, {flag: 'wx', mode})
    fs.renameSync(temporaryPath, targetPath)
  } finally {
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
      // rename 成功後は一時ファイルが存在しない。失敗時も元のエラーを保持する。
    }
  }
}
