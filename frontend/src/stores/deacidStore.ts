/**
 * 脱酸台账 store（Pinia setup store）
 * 保护科技检测室的一本账：处理单登记、逐轮处理与复测（返工按本侧重试）、
 * 按叶号对账与装订放行检查的派生值。复测 pH 只落本台账，不回写书叶原值。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import { deacidStateOf, isPassPh } from '@/utils/deacid'
import {
  type DeacidAttempt,
  type DeacidMethod,
  type DeacidRecord,
  type DeacidRecordDraft
} from '@/types/deacidRecord'

export interface AttemptInput {
  method: DeacidMethod
  retestPh: number
  operator: string
  date: string
  note: string
}

export const useDeacidStore = defineStore('deacid', () => {
  const records = ref<DeacidRecord[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadRecords(): Promise<void> {
    loading.value = true
    try {
      const rows = await db.deacidRecords.toArray()
      rows.sort((a, b) => (a.volumeId === b.volumeId ? a.leafNo - b.leafNo : a.volumeId.localeCompare(b.volumeId)))
      records.value = rows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '脱酸台账读取失败'
    } finally {
      loading.value = false
    }
  }

  function recordsOfVolume(volumeId: string): DeacidRecord[] {
    return records.value.filter((record) => record.volumeId === volumeId).sort((a, b) => a.leafNo - b.leafNo)
  }

  /** 按叶号查单（对账关键字）；同一叶号多单时返回第一张 */
  function recordOfLeafNo(volumeId: string, leafNo: number): DeacidRecord | undefined {
    return records.value.find((record) => record.volumeId === volumeId && record.leafNo === leafNo)
  }

  /** 检测登记：新立一份处理单，检测室那份先留空（无处理轮次） */
  async function registerSheet(draft: DeacidRecordDraft): Promise<DeacidRecord> {
    const now = Date.now()
    const row: DeacidRecord = {
      ...draft,
      attempts: draft.attempts ?? [],
      id: createId('deacid'),
      createdAt: now,
      updatedAt: now
    }
    await db.deacidRecords.put(row)
    await loadRecords()
    return row
  }

  /**
   * 登记一轮处理与复测；复测不合格即退回返工，检测室按本侧重试（轮次递增），
   * 修复室的工序记录不动。
   */
  async function appendAttempt(recordId: string, input: AttemptInput): Promise<DeacidAttempt | null> {
    const record = records.value.find((item) => item.id === recordId)
    if (!record) return null
    const attempt: DeacidAttempt = {
      round: record.attempts.length + 1,
      method: input.method,
      retestPh: input.retestPh,
      pass: isPassPh(input.retestPh),
      operator: input.operator,
      date: input.date,
      note: input.note
    }
    await db.deacidRecords.update(recordId, { attempts: [...record.attempts, attempt], updatedAt: Date.now() } as never)
    await loadRecords()
    return attempt
  }

  /** 删除处理单：用于对账后认领清理（如台账多记的叶号） */
  async function removeRecord(id: string): Promise<void> {
    await db.deacidRecords.delete(id)
    await loadRecords()
  }

  const totalCount = computed<number>(() => records.value.length)
  const passedCount = computed<number>(() => records.value.filter((record) => deacidStateOf(record) === 'passed').length)
  const reworkingCount = computed<number>(
    () => records.value.filter((record) => deacidStateOf(record) === 'reworking').length
  )
  const pendingCount = computed<number>(() => records.value.filter((record) => deacidStateOf(record) === 'pending').length)

  return {
    records,
    loading,
    ready,
    error,
    totalCount,
    passedCount,
    reworkingCount,
    pendingCount,
    loadRecords,
    recordsOfVolume,
    recordOfLeafNo,
    registerSheet,
    appendAttempt,
    removeRecord
  }
})
