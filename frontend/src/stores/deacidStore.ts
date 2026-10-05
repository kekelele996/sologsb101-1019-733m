/**
 * 脱酸处理单 store（保护科技检测室台账，Pinia setup store）
 * 维护检测室自己的一本账：开单 → 处理 → 复测；
 * 复测不合格只在本侧新增处理单重试，绝不回写修复室 Leaf.phValue 或 RepairOrder。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import {
  retestVerdict,
  type DeacidMethod,
  type DeacidOrder,
  type DeacidOrderDraft,
  type DeacidState
} from '@/types/deacidOrder'

export interface DeacidFilters {
  keyword: string
  states: DeacidState[]
  source: '' | 'normal' | 'legacy'
}

const DEFAULT_FILTERS: DeacidFilters = { keyword: '', states: [], source: '' }

export const useDeacidStore = defineStore('deacid', () => {
  const orders = ref<DeacidOrder[]>([])
  const filters = ref<DeacidFilters>({ ...DEFAULT_FILTERS })
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadOrders(): Promise<void> {
    loading.value = true
    try {
      const rows = await db.deacidOrders.toArray()
      rows.sort((a, b) =>
        a.volumeId === b.volumeId
          ? a.leafNo === b.leafNo
            ? a.attempt - b.attempt
            : a.leafNo - b.leafNo
          : a.volumeId.localeCompare(b.volumeId)
      )
      orders.value = rows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '脱酸台账读取失败'
    } finally {
      loading.value = false
    }
  }

  function ordersOfLeaf(volumeId: string, leafNo: number): DeacidOrder[] {
    return orders.value
      .filter((order) => order.volumeId === volumeId && order.leafNo === leafNo)
      .sort((a, b) => a.attempt - b.attempt)
  }

  /** 某册全部处理单（按叶号、次数排序） */
  function ordersOfVolumeSafe(volumeId: string): DeacidOrder[] {
    if (!volumeId) return []
    return orders.value
      .filter((order) => order.volumeId === volumeId)
      .sort((a, b) => (a.leafNo === b.leafNo ? a.attempt - b.attempt : a.leafNo - b.leafNo))
  }

  function nextAttempt(volumeId: string, leafNo: number): number {
    const list = ordersOfLeaf(volumeId, leafNo)
    return list.length === 0 ? 1 : Math.max(...list.map((order) => order.attempt)) + 1
  }

  const filteredOrders = computed<DeacidOrder[]>(() => {
    const keyword = filters.value.keyword.trim()
    return orders.value.filter((order) => {
      if (keyword.length > 0 && !String(order.leafNo).includes(keyword) && !order.operator.includes(keyword)) return false
      if (filters.value.states.length > 0 && !filters.value.states.includes(order.state)) return false
      if (filters.value.source && order.source !== filters.value.source) return false
      return true
    })
  })

  const pendingCount = computed(() => orders.value.filter((order) => order.state !== 'passed').length)
  const passedCount = computed(() => orders.value.filter((order) => order.state === 'passed').length)
  const legacyPendingCount = computed(
    () => orders.value.filter((order) => order.source === 'legacy' && order.state === 'pending').length
  )

  function setKeyword(keyword: string): void {
    filters.value = { ...filters.value, keyword }
  }
  function setStates(states: DeacidState[]): void {
    filters.value = { ...filters.value, states }
  }
  function setSource(source: DeacidFilters['source']): void {
    filters.value = { ...filters.value, source }
  }
  function resetFilters(): void {
    filters.value = { ...DEFAULT_FILTERS }
  }

  /** 检测室开单（含从对账缺单 / 历史数据补录） */
  async function createOrder(draft: DeacidOrderDraft): Promise<DeacidOrder> {
    const now = Date.now()
    const row: DeacidOrder = { ...draft, id: createId('deacid'), createdAt: now, updatedAt: now }
    await db.deacidOrders.put(row)
    await loadOrders()
    return row
  }

  async function updateOrder(id: string, patch: Partial<DeacidOrder>): Promise<void> {
    await db.deacidOrders.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadOrders()
  }

  /** 回填脱酸方式与处理人：待处理 → 已脱酸待复测 */
  async function markTreated(id: string, payload: { method: DeacidMethod; operator: string; treatedDate: string; remark?: string }): Promise<void> {
    const order = orders.value.find((item) => item.id === id)
    if (!order || (order.state !== 'pending' && order.state !== 'failed')) return
    await updateOrder(id, {
      method: payload.method,
      operator: payload.operator,
      treatedDate: payload.treatedDate,
      remark: payload.remark ?? order.remark,
      state: 'treated'
    })
  }

  /**
   * 复测：写复测 pH 与日期，按 6.5–8.5 判合格 / 不合格。
   * 复测值只落在检测室台账，不盖修复室原值。
   */
  async function recordRetest(id: string, payload: { retestPh: number; retestDate: string }): Promise<DeacidState> {
    const order = orders.value.find((item) => item.id === id)
    if (!order) return 'pending'
    const verdict = retestVerdict(payload.retestPh)
    if (verdict === 'none') return order.state
    const state: DeacidState = verdict === 'pass' ? 'passed' : 'failed'
    await updateOrder(id, { retestPh: payload.retestPh, retestDate: payload.retestDate, state })
    return state
  }

  /**
   * 返工：复测不合格的叶退回检测室，按本侧重试 —— 新增一张处理单，
   * 检测室自己的账延续 attempt，修复室工序记录不动。
   */
  async function retryFromFailed(order: DeacidOrder, payload: { remark?: string } = {}): Promise<DeacidOrder> {
    const draft: DeacidOrderDraft = {
      volumeId: order.volumeId,
      leafNo: order.leafNo,
      leafId: order.leafId,
      originalPh: order.originalPh,
      method: null,
      operator: '',
      treatedDate: new Date().toISOString().slice(0, 10),
      retestPh: null,
      retestDate: '',
      state: 'pending',
      source: 'normal',
      attempt: nextAttempt(order.volumeId, order.leafNo),
      remark: payload.remark ?? `第 ${order.attempt} 次复测不合格（${order.retestPh ?? '—'}），退回返工`
    }
    return createOrder(draft)
  }

  /** 对账认领：把悬挂 / 孤儿单重新挂到修复室书叶记录（只动检测室单据） */
  async function reattach(orderId: string, leafId: string, patch: { volumeId: string; leafNo: number; originalPh: number | null }): Promise<void> {
    await updateOrder(orderId, { leafId, volumeId: patch.volumeId, leafNo: patch.leafNo, originalPh: patch.originalPh })
  }

  async function removeOrder(id: string): Promise<void> {
    await db.deacidOrders.delete(id)
    await loadOrders()
  }

  return {
    orders,
    filters,
    loading,
    ready,
    error,
    filteredOrders,
    pendingCount,
    passedCount,
    legacyPendingCount,
    loadOrders,
    ordersOfLeaf,
    ordersOfVolumeSafe,
    nextAttempt,
    setKeyword,
    setStates,
    setSource,
    resetFilters,
    createOrder,
    updateOrder,
    markTreated,
    recordRetest,
    retryFromFailed,
    reattach,
    removeOrder
  }
})
