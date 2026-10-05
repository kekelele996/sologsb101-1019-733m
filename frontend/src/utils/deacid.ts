/**
 * 脱酸领域逻辑：达标判定、处理单状态派生、按叶号对账、装订放行检查、历史处理单拆分。
 * 纯函数，不触碰 Dexie；被 store、页面与 db.ts 升级迁移共同消费。
 */
import type { Leaf } from '@/types/leaf'
import {
  type DeacidAttempt,
  type DeacidRecord,
  type DeacidState
} from '@/types/deacidRecord'

/** 复测 pH 达标线：≥ 7.0 视为脱酸达标 */
export const PH_PASS_MIN = 7

export function isPassPh(ph: number): boolean {
  return ph >= PH_PASS_MIN
}

/** 最近一轮处理记录；检测室那份还留空时返回 null */
export function latestAttempt(record: DeacidRecord): DeacidAttempt | null {
  return record.attempts.length === 0 ? null : (record.attempts[record.attempts.length - 1] as DeacidAttempt)
}

/** 处理单状态派生：无记录 → 待处理；最近一轮未达标 → 返工中；达标 → 已达标 */
export function deacidStateOf(record: DeacidRecord): DeacidState {
  const last = latestAttempt(record)
  if (!last) return 'pending'
  return last.pass ? 'passed' : 'reworking'
}

export interface ReconcileResult {
  /** 修复室有、检测室台账缺的叶号 */
  missingInLab: number[]
  /** 台账有、修复室查无此叶的叶号（摆出来等人认领） */
  extraInLab: number[]
  /** 同一叶号在台账里记了不止一单 */
  duplicated: number[]
}

/** 两边按叶号对账：输入同一册的书叶与处理单，列出对不上的叶号 */
export function reconcileByLeafNo(leaves: Leaf[], records: DeacidRecord[]): ReconcileResult {
  const leafNos = new Set(leaves.map((leaf) => leaf.leafNo))
  const recordCountByNo = new Map<number, number>()
  records.forEach((record) => {
    recordCountByNo.set(record.leafNo, (recordCountByNo.get(record.leafNo) ?? 0) + 1)
  })
  const recordNos = new Set(recordCountByNo.keys())
  const missingInLab = [...leafNos].filter((no) => !recordNos.has(no)).sort((a, b) => a - b)
  const extraInLab = [...recordNos].filter((no) => !leafNos.has(no)).sort((a, b) => a - b)
  const duplicated = [...recordCountByNo.entries()]
    .filter(([, count]) => count > 1)
    .map(([no]) => no)
    .sort((a, b) => a - b)
  return { missingInLab, extraInLab, duplicated }
}

export interface VolumeDeacidCheck {
  /** 修复室登记的叶号数（同叶号叠加破损只算一叶） */
  totalLeafNos: number
  /** 复测达标叶数 */
  passed: number
  /** 有单但最近一轮未达标（返工中） */
  reworking: number
  /** 有单未处理（检测室那份还留空） */
  pending: number
  /** 无处理单 */
  missing: number
  /** 待认领（台账多出的叶号） */
  extra: number
  /** 全册复测达标，修复室可放行装订 */
  ready: boolean
}

/** 装订放行检查：一册书叶全部复测达标才放行；无书叶的册次不拦 */
export function checkVolumeDeacid(leaves: Leaf[], records: DeacidRecord[]): VolumeDeacidCheck {
  const leafNos = Array.from(new Set(leaves.map((leaf) => leaf.leafNo)))
  let passed = 0
  let reworking = 0
  let pending = 0
  let missing = 0
  leafNos.forEach((no) => {
    const list = records.filter((record) => record.leafNo === no)
    if (list.length === 0) {
      missing += 1
      return
    }
    if (list.some((record) => deacidStateOf(record) === 'passed')) {
      passed += 1
      return
    }
    if (list.some((record) => deacidStateOf(record) === 'reworking')) reworking += 1
    else pending += 1
  })
  const leafNoSet = new Set(leafNos)
  const extra = new Set(records.filter((record) => !leafNoSet.has(record.leafNo)).map((record) => record.leafNo)).size
  return {
    totalLeafNos: leafNos.length,
    passed,
    reworking,
    pending,
    missing,
    extra,
    ready: leafNos.length === 0 ? true : passed === leafNos.length
  }
}

export interface SplitHistoryResult {
  /** 按现有 pH 拆出的历史处理单（检测室那份先留空） */
  sheets: DeacidRecord[]
  /** 拆不出的书叶 id（没有可依据的原值 pH，只读留着） */
  readonlyLeafIds: string[]
}

/**
 * 旧数据升级：照书叶现有 pH 逐叶拆一份历史处理单，同一叶号只拆一份；
 * 没有原值 pH 可依据的书叶拆不出，标记为只读。
 */
export function splitHistorySheets(
  leaves: Leaf[],
  makeId: () => string,
  now: number = Date.now()
): SplitHistoryResult {
  const seen = new Set<string>()
  const sheets: DeacidRecord[] = []
  const readonlyLeafIds: string[] = []
  leaves.forEach((leaf) => {
    const ph = leaf.phValue
    if (typeof ph === 'number' && Number.isFinite(ph)) {
      const key = `${leaf.volumeId}#${leaf.leafNo}`
      if (seen.has(key)) return
      seen.add(key)
      sheets.push({
        id: makeId(),
        volumeId: leaf.volumeId,
        leafNo: leaf.leafNo,
        prePh: ph,
        source: 'history',
        attempts: [],
        createdAt: now,
        updatedAt: now
      })
    } else {
      readonlyLeafIds.push(leaf.id)
    }
  })
  return { sheets, readonlyLeafIds }
}
