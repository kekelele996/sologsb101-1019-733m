/**
 * useDeacidGate()：脱酸装订闸门 + 修复室 / 检测室按叶号对账
 * 被检测台账页（/deacid）、书叶页、装订归档页（/export）消费。
 *
 * 规则：
 * 1. 一册书叶「全部复测达标」修复室才放它进装订：
 *    修复室原值判定为需脱酸的叶（pH < 6.5 或破损含酸化），
 *    其最新处理单必须复测合格；历史空单 / 失败 / 缺单 / pH 无法判定均拦截。
 * 2. 两边按叶号对账，对不上只把叶号 / 单据摆出来等人认领，不自动改写。
 * 3. 检测室返工只在自己台账新增处理单（本侧重试），修复室工序记录不动。
 */
import { computed, type ComputedRef } from 'vue'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useDeacidStore } from '@/stores/deacidStore'
import { DAMAGE_TYPE_LABEL, type Leaf } from '@/types/leaf'
import {
  isValidPh,
  needsDeacid,
  retestVerdict,
  type DeacidOrder
} from '@/types/deacidOrder'

/** 拦截原因：缺处理单 / 历史空单待复测 / 复测不合格待返工 / pH 无法判定（拆不出，只读留着） */
export type GateBlockReason = 'missing' | 'legacyPending' | 'failed' | 'unknownPh'

export interface GateBlockItem {
  volumeId: string
  leafNo: number
  leafId: string | null
  reason: GateBlockReason
  /** 最新处理单（缺单时为 null） */
  order: DeacidOrder | null
}

export interface VolumeGate {
  volumeId: string
  /** 需脱酸叶数（按叶号去重） */
  needCount: number
  /** 复测合格叶数 */
  passedCount: number
  /** 被拦截叶数 */
  blockedCount: number
  /** 是否放行装订 */
  ready: boolean
  /** 放行率 0-100 */
  percent: number
  blocks: GateBlockItem[]
}

/** 对账：修复室有、检测室没有处理单的叶号（缺单） */
export interface MissingOrderLeaf {
  volumeId: string
  leafNo: number
  leafId: string
  ph: number | null
}

/** 对账：检测室有单、修复室对不上（孤儿单：悬挂 leafId 或叶号在该册无书叶） */
export interface OrphanOrder {
  order: DeacidOrder
  kind: 'dangling' | 'leafNoMismatch'
  /** 同叶号可重新认领的书叶候选 */
  candidates: Leaf[]
}

export interface DeacidGateResult {
  gateOf: (volumeId: string) => VolumeGate
  gateMap: ComputedRef<Record<string, VolumeGate>>
  readyVolumeIds: ComputedRef<Set<string>>
  missingLeaves: ComputedRef<MissingOrderLeaf[]>
  orphanOrders: ComputedRef<OrphanOrder[]>
  latestOrderOf: (volumeId: string, leafNo: number) => DeacidOrder | null
  orderChain: (volumeId: string, leafNo: number) => DeacidOrder[]
}

export const GATE_BLOCK_LABEL: Record<GateBlockReason, string> = {
  missing: '未送检（缺处理单）',
  legacyPending: '历史拆单待复测',
  failed: '复测不合格待返工',
  unknownPh: '原值 pH 无法判定（只读）'
}

/** 同一物理叶的判定：该叶是否需要脱酸（pH 或破损类型含酸化） */
export function leafNeedsDeacid(leaf: Leaf): boolean {
  if (leaf.damageType === 'acid') return true
  return needsDeacid(isValidPh(leaf.phValue) ? leaf.phValue : null)
}

export function useDeacidGate(): DeacidGateResult {
  const bookStore = useBookStore()
  const leafStore = useLeafStore()
  const deacidStore = useDeacidStore()

  /** 处理单按册 + 叶号归链，链内按 attempt / 时间排序，末张为最新 */
  const orderChain = (volumeId: string, leafNo: number): DeacidOrder[] =>
    deacidStore.orders
      .filter((order) => order.volumeId === volumeId && order.leafNo === leafNo)
      .sort((a, b) => (a.attempt === b.attempt ? a.updatedAt - b.updatedAt : a.attempt - b.attempt))

  const latestOrderOf = (volumeId: string, leafNo: number): DeacidOrder | null => {
    const chain = orderChain(volumeId, leafNo)
    return chain.length === 0 ? null : chain[chain.length - 1]
  }

  /** 每册的需脱酸叶（按叶号去重，取该叶号代表记录）与闸门判定 */
  const gateMap = computed<Record<string, VolumeGate>>(() => {
    const result: Record<string, VolumeGate> = {}
    bookStore.volumes.forEach((volume) => {
      const leaves = leafStore.leavesOfVolume(volume.id)
      const byLeafNo = new Map<number, Leaf[]>()
      leaves.forEach((leaf) => {
        const list = byLeafNo.get(leaf.leafNo) ?? []
        list.push(leaf)
        byLeafNo.set(leaf.leafNo, list)
      })

      const blocks: GateBlockItem[] = []
      let needCount = 0
      let passedCount = 0

      byLeafNo.forEach((sameLeaf, leafNo) => {
        const needs = sameLeaf.some(leafNeedsDeacid)
        // 原值 pH 无法判定且没有任何有效记录：拆不出的旧数据只读拦截
        const hasValidPh = sameLeaf.some((leaf) => isValidPh(leaf.phValue))
        if (!needs) return
        needCount += 1
        if (!hasValidPh) {
          blocks.push({ volumeId: volume.id, leafNo, leafId: sameLeaf[0]?.id ?? null, reason: 'unknownPh', order: null })
          return
        }
        const latest = latestOrderOf(volume.id, leafNo)
        if (!latest) {
          blocks.push({ volumeId: volume.id, leafNo, leafId: sameLeaf[0]?.id ?? null, reason: 'missing', order: null })
          return
        }
        if (latest.state === 'passed' && retestVerdict(latest.retestPh) === 'pass') {
          passedCount += 1
          return
        }
        // 历史拆单的空单（方式 / 复测未补）单列一类；其余为失败 / 待复测 / 已处理未复测
        const reason: GateBlockReason =
          latest.source === 'legacy' && latest.method === null
            ? 'legacyPending'
            : latest.state === 'failed'
              ? 'failed'
              : 'missing'
        blocks.push({ volumeId: volume.id, leafNo, leafId: latest.leafId, reason, order: latest })
      })

      const blockedCount = blocks.length
      result[volume.id] = {
        volumeId: volume.id,
        needCount,
        passedCount,
        blockedCount,
        ready: needCount > 0 && blockedCount === 0,
        percent: needCount === 0 ? 0 : Math.round((passedCount / needCount) * 100),
        blocks
      }
    })
    return result
  })

  const gateOf = (volumeId: string): VolumeGate =>
    gateMap.value[volumeId] ?? {
      volumeId,
      needCount: 0,
      passedCount: 0,
      blockedCount: 0,
      ready: false,
      percent: 0,
      blocks: []
    }

  /** 无需脱酸叶的册次：没有酸化叶就不受脱酸闸门约束（true），交由其他工序把关 */
  const readyVolumeIds = computed<Set<string>>(() => {
    const set = new Set<string>()
    Object.values(gateMap.value).forEach((gate) => {
      if (gate.needCount === 0 || gate.ready) set.add(gate.volumeId)
    })
    return set
  })

  /** 对账一：修复室登记了需脱酸叶，检测室却没有任何处理单 */
  const missingLeaves = computed<MissingOrderLeaf[]>(() => {
    const list: MissingOrderLeaf[] = []
    bookStore.volumes.forEach((volume) => {
      const leaves = leafStore.leavesOfVolume(volume.id)
      const byLeafNo = new Map<number, Leaf[]>()
      leaves.forEach((leaf) => {
        const bucket = byLeafNo.get(leaf.leafNo) ?? []
        bucket.push(leaf)
        byLeafNo.set(leaf.leafNo, bucket)
      })
      byLeafNo.forEach((sameLeaf, leafNo) => {
        if (!sameLeaf.some(leafNeedsDeacid)) return
        if (deacidStore.orders.some((order) => order.volumeId === volume.id && order.leafNo === leafNo)) return
        const representative = sameLeaf.find((leaf) => leaf.damageType === 'acid') ?? sameLeaf[0]
        list.push({
          volumeId: volume.id,
          leafNo,
          leafId: representative.id,
          ph: isValidPh(representative.phValue) ? representative.phValue : null
        })
      })
    })
    return list
  })

  /** 对账二：检测室的单在修复室对不上 —— 摆出来等人认领，不自动改 */
  const orphanOrders = computed<OrphanOrder[]>(() =>
    deacidStore.orders
      .map((order) => {
        const volumeLeaves = leafStore.leavesOfVolume(order.volumeId)
        const sameLeafNo = volumeLeaves.filter((leaf) => leaf.leafNo === order.leafNo)
        // leafId 悬挂：单据指向的书叶记录不存在
        const dangling = order.leafId === null || !volumeLeaves.some((leaf) => leaf.id === order.leafId)
        if (!dangling) return null
        // 叶号还能在修复室找到 → 可认领重挂；连叶号都对不上 → 纯孤儿
        const kind: OrphanOrder['kind'] = sameLeafNo.length > 0 ? 'dangling' : 'leafNoMismatch'
        return { order, kind, candidates: sameLeafNo }
      })
      .filter((item): item is OrphanOrder => item !== null)
  )

  return { gateOf, gateMap, readyVolumeIds, missingLeaves, orphanOrders, latestOrderOf, orderChain }
}

/** 供页面展示的叶号对账文案（破损类型 + pH 原值） */
export function describeLeafForReconcile(leaf: Leaf): string {
  return `${DAMAGE_TYPE_LABEL[leaf.damageType]} · 原值 pH ${isValidPh(leaf.phValue) ? leaf.phValue : '—'}`
}
