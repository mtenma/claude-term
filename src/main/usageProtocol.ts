import type {UsageErrorCode, UsageEvent, UsagePeriod, UsageReport} from '../shared/types'
import type {ScanRoots} from './usageScan'

// main プロセスと集計用の utilityProcess の間のメッセージ

export interface UsageServiceConfig {
  db: string
  roots: ScanRoots
  home: string
}

export type ServiceRequest =
  | {type: 'init'; config: UsageServiceConfig}
  | {type: 'scan'}
  | {type: 'report'; id: number; period: UsagePeriod; now: number}

export type ServiceMessage =
  | {type: 'report'; id: number; report: UsageReport}
  | {type: 'reportError'; id: number; code: UsageErrorCode}
  | {type: 'event'; event: UsageEvent}
