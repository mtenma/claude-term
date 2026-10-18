import * as fs from 'node:fs'
import type {UsageErrorCode} from '../shared/types'
import type {ServiceMessage, ServiceRequest, UsageServiceConfig} from './usageProtocol'
import {buildReport, emptyReport} from './usageReport'
import {resolvePendingProjects, scanUsage} from './usageScan'
import {UsageStore, UsageStoreError} from './usageStore'

// コスト画面の集計を担う utilityProcess。SQLite や記録の読込みで異常が起きても、
// PTY を抱える main プロセスを巻き込まないよう別プロセスで動かす

const port = process.parentPort
let config: UsageServiceConfig | null = null
let store: UsageStore | null = null
let scanning = false
let scanAgain = false

const post = (message: ServiceMessage) => port.postMessage(message)

// 例外の文面は本文の断片を含み得るため、種類だけを返す
const errorCode = (error: unknown): UsageErrorCode =>
  error instanceof UsageStoreError ? error.code
    : (error as {code?: string}).code === 'ERR_SQLITE_ERROR' ? 'db_failed' : 'internal'

function openStore(): UsageStore {
  if (!config) throw new Error('not initialized')
  store ??= new UsageStore(config.db)
  return store
}

async function scan(): Promise<void> {
  if (scanning) {
    // 取込み中に重なった要求は、終わった後の 1 回にまとめる
    scanAgain = true
    return
  }
  scanning = true
  try {
    do {
      scanAgain = false
      const current = openStore()
      const firstImport = current.getMeta('lastScanAt') === null
      const result = await scanUsage({
        roots: config!.roots,
        store: current,
        resolve: {home: config!.home},
        onProgress: (doneBytes, totalBytes) =>
          post({type: 'event', event: {kind: 'progress', doneBytes, totalBytes, firstImport}}),
      })
      post({
        type: 'event',
        event: {
          kind: 'scanned', at: Date.now(),
          parseErrors: result.parseErrors, longLines: result.longLines, unreadable: result.unreadable,
        },
      })
    } while (scanAgain)
  } catch (error) {
    post({type: 'event', event: {kind: 'error', code: errorCode(error)}})
  } finally {
    scanning = false
  }
}

port.on('message', ({data}: {data: ServiceRequest}) => {
  if (data.type === 'init') {
    config = data.config
  } else if (data.type === 'scan') {
    void scan()
  } else if (data.type === 'report') {
    try {
      const {db, home} = config!
      // 集計データがない(初回・削除の直後)ときは、取り込むまで DB を作らない
      if (!store && !fs.existsSync(db)) {
        post({type: 'report', id: data.id, report: emptyReport(data.period, data.now, db, home)})
        return
      }
      const current = openStore()
      // 取り込みの途中でも、取り込めたセッションのプロジェクトを決めてから集計する
      // (取り込みはファイルごとに処理を返すので、書込みと重ならない)
      resolvePendingProjects(current, {home})
      const report = buildReport({store: current, period: data.period, now: data.now, home})
      post({type: 'report', id: data.id, report})
    } catch (error) {
      post({type: 'reportError', id: data.id, code: errorCode(error)})
    }
  }
})
