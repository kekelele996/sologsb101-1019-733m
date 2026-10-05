<script setup lang="ts">
/**
 * /deacid 保护科技检测室 · 脱酸台账
 * 另立一本账：开单（脱酸方式）→ 复测 pH；复测不合格退回本侧新增一单返工，
 * 不回盖修复室原值 pH、不动修复室工序记录。
 * 同时承担「按叶号对账」：缺单叶号、孤儿 / 悬挂处理单只读摆出等人认领。
 * 消费 DeacidOrder、Leaf、Volume；复用 <FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { computed, reactive, ref, watch, watchEffect } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Aim, CircleCheck, Delete, DocumentAdd, RefreshRight, WarningFilled } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { useFilterQuery, type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useDeacidStore } from '@/stores/deacidStore'
import { useDeacidGate, GATE_BLOCK_LABEL, leafNeedsDeacid, type GateBlockItem } from '@/hooks/useDeacidGate'
import { BINDING_TYPE_LABEL, VOLUME_STATE_LABEL, isVolumeLocked } from '@/types/volume'
import { DAMAGE_TYPE_LABEL, type DamageType, type Leaf } from '@/types/leaf'
import {
  DEACID_METHOD_LABEL,
  DEACID_METHOD_OPTIONS,
  DEACID_SOURCE_LABEL,
  DEACID_STATE_OPTIONS,
  DEACID_RETEST_MAX,
  DEACID_RETEST_MIN,
  createEmptyOrderDraft,
  deacidStateColor,
  deacidStateLabel,
  needsDeacid,
  type DeacidMethod,
  type DeacidOrder
} from '@/types/deacidOrder'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const deacidStore = useDeacidStore()
const { gateOf, missingLeaves, orphanOrders } = useDeacidGate()

/* ----------------------------- 册次选择 ----------------------------- */
const currentBookId = computed({
  get: () => bookStore.currentBookId ?? '',
  set: (value: string) => bookStore.setCurrentBook(value || null)
})
const currentVolumeId = computed({
  get: () => bookStore.currentVolumeId ?? '',
  set: (value: string) => bookStore.setCurrentVolume(value || null)
})

const volumes = computed(() => (currentBookId.value ? bookStore.volumesOfBook(currentBookId.value) : []))

watch(
  [volumes, currentBookId],
  () => {
    if (volumes.value.length === 0) {
      currentVolumeId.value = ''
      return
    }
    if (!volumes.value.some((volume) => volume.id === currentVolumeId.value)) {
      currentVolumeId.value = volumes.value[0]?.id ?? ''
    }
  },
  { immediate: true }
)

const currentVolume = computed(() => volumes.value.find((volume) => volume.id === currentVolumeId.value) ?? null)
const locked = computed(() => (currentVolume.value ? isVolumeLocked(currentVolume.value.state) : false))
const gate = computed(() => (currentVolumeId.value ? gateOf(currentVolumeId.value) : null))

function volumeLabel(volumeId: string): string {
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '册次已删除'
  const book = bookStore.bookById(volume.bookId)
  return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册`
}

/* ----------------------------- 筛选（URL query） ----------------------------- */
const FILTER_KEYS = ['state', 'source'] as const
const url = useFilterQuery(FILTER_KEYS)

const filterModel = computed<FilterModel>(() => ({
  keyword: url.keyword.value,
  state: url.values.value.state ?? [],
  source: (url.values.value.source ?? [])[0] ?? ''
}))

const filterSelects = [
  { key: 'state', label: '处理状态', options: DEACID_STATE_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
  {
    key: 'source',
    label: '单据来源',
    options: [
      { label: DEACID_SOURCE_LABEL.normal, value: 'normal' },
      { label: DEACID_SOURCE_LABEL.legacy, value: 'legacy' }
    ]
  }
]

watchEffect(() => {
  deacidStore.setKeyword(url.keyword.value)
  deacidStore.setStates((url.values.value.state ?? []) as DeacidOrder['state'][])
  const source = (url.values.value.source ?? [])[0]
  deacidStore.setSource(source === 'normal' || source === 'legacy' ? source : '')
})

function handleFilterChange(next: FilterModel): void {
  url.apply({
    kw: typeof next.keyword === 'string' ? next.keyword : '',
    state: (next.state as string[]) ?? [],
    source: typeof next.source === 'string' && next.source ? [next.source] : []
  })
}

/** 当前册次的处理单链（按叶号、attempt 排序） */
const volumeOrders = computed(() => deacidStore.ordersOfVolumeSafe(currentVolumeId.value))

/** 每叶号取最新单用于台账概览；完整链在展开行查看 */
const leafGroups = computed(() => {
  const groups = new Map<number, DeacidOrder[]>()
  volumeOrders.value.forEach((order) => {
    const list = groups.get(order.leafNo) ?? []
    list.push(order)
    groups.set(order.leafNo, list)
  })
  return Array.from(groups.entries())
    .map(([leafNo, chain]) => {
      const sorted = [...chain].sort((a, b) => a.attempt - b.attempt)
      const leaves = leafStore.leavesOfVolume(currentVolumeId.value).filter((leaf) => leaf.leafNo === leafNo)
      return { leafNo, chain: sorted, latest: sorted[sorted.length - 1], leaves }
    })
    .sort((a, b) => a.leafNo - b.leafNo)
})

/** 该册需脱酸但检测室还没开单的叶号（缺单） */
const missingInVolume = computed(() =>
  missingLeaves.value.filter((item) => item.volumeId === currentVolumeId.value)
)

const blocksByLeafNo = computed(() => {
  const map = new Map<number, GateBlockItem>()
  gate.value?.blocks.forEach((block) => map.set(block.leafNo, block))
  return map
})

/* ----------------------------- 开单 ----------------------------- */
const createDialog = ref(false)
const createForm = reactive<{ leafNo: number | null; method: DeacidMethod; operator: string; treatedDate: string }>({
  leafNo: null,
  method: 'liquid',
  operator: '',
  treatedDate: new Date().toISOString().slice(0, 10)
})

/** 可开单叶号：修复室登记的需脱酸叶，且检测室最新单尚未复测合格（合格叶只能从失败单返工） */
const openableLeafNos = computed(() => {
  if (!currentVolumeId.value) return []
  const leaves = leafStore.leavesOfVolume(currentVolumeId.value)
  const byLeafNo = new Map<number, { ph: number | null; needs: boolean }>()
  leaves.forEach((leaf) => {
    const prev = byLeafNo.get(leaf.leafNo)
    const needs = leafNeedsDeacid(leaf) || prev?.needs === true
    byLeafNo.set(leaf.leafNo, { ph: typeof leaf.phValue === 'number' ? leaf.phValue : prev?.ph ?? null, needs })
  })
  return Array.from(byLeafNo.entries())
    .filter(([leafNo, info]) => {
      if (!info.needs) return false
      const latest = [...deacidStore.ordersOfLeaf(currentVolumeId.value, leafNo)].pop()
      return !latest || latest.state !== 'passed'
    })
    .map(([leafNo, info]) => ({ leafNo, ...info }))
})

function openCreate(prefillLeafNo?: number): void {
  if (!currentVolumeId.value) {
    ElMessage.warning('请先选择册次')
    return
  }
  if (locked.value) {
    ElMessage.warning('该册已装订锁定，检测室不能再开单')
    return
  }
  const candidates = openableLeafNos.value
  if (candidates.length === 0) {
    ElMessage.info('该册没有需要脱酸的叶')
    return
  }
  createForm.leafNo = prefillLeafNo ?? candidates[0]?.leafNo ?? null
  createForm.method = 'liquid'
  createForm.operator = ''
  createForm.treatedDate = new Date().toISOString().slice(0, 10)
  createDialog.value = true
}

async function submitCreate(): Promise<void> {
  if (createForm.leafNo === null) {
    ElMessage.warning('请选择叶号')
    return
  }
  const leaves = leafStore.leavesOfVolume(currentVolumeId.value).filter((leaf) => leaf.leafNo === createForm.leafNo)
  const representative = leaves.find((leaf) => leaf.damageType === 'acid') ?? leaves[0]
  const originalPh = representative && typeof representative.phValue === 'number' ? representative.phValue : null
  const draft = createEmptyOrderDraft(currentVolumeId.value, createForm.leafNo, representative?.id ?? null, originalPh, deacidStore.nextAttempt(currentVolumeId.value, createForm.leafNo))
  draft.method = createForm.method
  draft.operator = createForm.operator
  draft.treatedDate = createForm.treatedDate
  draft.state = 'treated'
  await deacidStore.createOrder(draft)
  ElMessage.success(`第 ${createForm.leafNo} 叶脱酸处理单已开，等待复测`)
  createDialog.value = false
}

/* ----------------------------- 复测 ----------------------------- */
const retestDialog = ref(false)
const retestTarget = ref<DeacidOrder | null>(null)
const retestForm = reactive<{ retestPh: number; retestDate: string }>({
  retestPh: 7,
  retestDate: new Date().toISOString().slice(0, 10)
})

function openRetest(order: DeacidOrder): void {
  if (locked.value) {
    ElMessage.warning('该册已装订锁定')
    return
  }
  retestTarget.value = order
  retestForm.retestPh = 7
  retestForm.retestDate = new Date().toISOString().slice(0, 10)
  retestDialog.value = true
}

async function submitRetest(): Promise<void> {
  if (!retestTarget.value) return
  const state = await deacidStore.recordRetest(retestTarget.value.id, { ...retestForm })
  if (state === 'passed') {
    ElMessage.success(`第 ${retestTarget.value.leafNo} 叶复测 pH ${retestForm.retestPh} 达标`)
  } else if (state === 'failed') {
    ElMessage.warning(`第 ${retestTarget.value.leafNo} 叶复测 pH ${retestForm.retestPh} 不合格，已退回检测室`)
  }
  retestDialog.value = false
}

/* ----------------------------- 返工（本侧重试） ----------------------------- */
async function retry(order: DeacidOrder): Promise<void> {
  if (locked.value) {
    ElMessage.warning('该册已装订锁定')
    return
  }
  try {
    await ElMessageBox.confirm(
      `第 ${order.leafNo} 叶复测不合格，将在检测室台账新增一张返工处理单（第 ${order.attempt + 1} 次），修复室工序记录不动。`,
      '退回检测室返工',
      { type: 'warning', confirmButtonText: '新增返工单', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const created = await deacidStore.retryFromFailed(order)
  ElMessage.success(`已开第 ${created.attempt} 次返工单，请补录脱酸方式`)
}

/** 回填脱酸方式（pending 历史单 / 返工单） */
const treatDialog = ref(false)
const treatTarget = ref<DeacidOrder | null>(null)
const treatForm = reactive<{ method: DeacidMethod; operator: string; treatedDate: string }>({
  method: 'liquid',
  operator: '',
  treatedDate: new Date().toISOString().slice(0, 10)
})

function openTreat(order: DeacidOrder): void {
  treatTarget.value = order
  treatForm.method = order.method ?? 'liquid'
  treatForm.operator = order.operator
  treatForm.treatedDate = order.treatedDate || new Date().toISOString().slice(0, 10)
  treatDialog.value = true
}

async function submitTreat(): Promise<void> {
  if (!treatTarget.value) return
  await deacidStore.markTreated(treatTarget.value.id, { ...treatForm })
  ElMessage.success('已回填脱酸方式，等待复测')
  treatDialog.value = false
}

async function removeOrder(order: DeacidOrder): Promise<void> {
  try {
    await ElMessageBox.confirm(`将删除第 ${order.leafNo} 叶第 ${order.attempt} 次脱酸处理单。`, '删除处理单', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await deacidStore.removeOrder(order.id)
  ElMessage.success('已删除')
}

/* ----------------------------- 对账认领 ----------------------------- */
const claimDialog = ref(false)
const claimTarget = ref<(typeof orphanOrders.value)[number] | null>(null)
const claimLeafId = ref('')

function openClaim(item: (typeof orphanOrders.value)[number]): void {
  claimTarget.value = item
  claimLeafId.value = item.candidates[0]?.id ?? ''
  claimDialog.value = true
}

async function submitClaim(): Promise<void> {
  if (!claimTarget.value || !claimLeafId.value) return
  const leaf = leafStore.leafById(claimLeafId.value)
  if (!leaf) return
  await deacidStore.reattach(claimTarget.value.order.id, leaf.id, {
    volumeId: leaf.volumeId,
    leafNo: leaf.leafNo,
    originalPh: typeof leaf.phValue === 'number' ? leaf.phValue : null
  })
  ElMessage.success(`处理单已重新认领为第 ${leaf.leafNo} 叶`)
  claimDialog.value = false
}

/** 缺单叶号跳开单 */
function createForMissing(leafNo: number): void {
  openCreate(leafNo)
}

function needsTag(ph: number | null): string {
  return ph !== null && needsDeacid(ph) ? `原值 pH ${ph}` : ''
}

/** 以下包装给模板插槽行使用，避免隐式 any 索引 */
interface LeafGroupRow {
  leafNo: number
  chain: DeacidOrder[]
  latest: DeacidOrder
  leaves: Leaf[]
}
function damageLabel(type: DamageType): string {
  return DAMAGE_TYPE_LABEL[type]
}
function methodLabel(method: DeacidMethod | null): string {
  return method ? DEACID_METHOD_LABEL[method] : '—（待补录）'
}
function sourceLabel(source: DeacidOrder['source']): string {
  return DEACID_SOURCE_LABEL[source]
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>保护科技检测室 · 脱酸台账</h2>
        <p>检测室另立一本账：脱酸方式与复测 pH 只记在处理单上，不覆盖修复室送检前原值；复测不合格在本侧新增返工单。</p>
      </div>
    </div>

    <el-card shadow="never" style="margin-bottom: 14px">
      <div class="gb-toolbar">
        <span class="gb-muted">古籍：</span>
        <el-select v-model="currentBookId" style="width: 240px" placeholder="先选择古籍">
          <el-option v-for="book in bookStore.books" :key="book.id" :label="`《${book.title}》`" :value="book.id" />
        </el-select>
        <span class="gb-muted">册次：</span>
        <el-radio-group v-model="currentVolumeId">
          <el-radio-button v-for="volume in volumes" :key="volume.id" :value="volume.id">
            第 {{ volume.volumeNo }} 册 · {{ BINDING_TYPE_LABEL[volume.bindingType] }} · {{ VOLUME_STATE_LABEL[volume.state] }}
          </el-radio-button>
        </el-radio-group>
      </div>
    </el-card>

    <!-- 装订闸门提示 -->
    <el-alert
      v-if="gate"
      :type="gate.ready ? 'success' : gate.needCount === 0 ? 'info' : 'error'"
      show-icon
      :closable="false"
      style="margin-bottom: 14px"
      :title="
        gate.ready
          ? `该册 ${gate.passedCount}/${gate.needCount} 叶复测达标，修复室可放行进装订`
          : gate.needCount === 0
            ? '该册没有需脱酸叶，脱酸闸门不拦截装订'
            : `该册脱酸复测 ${gate.passedCount}/${gate.needCount} 叶达标，${gate.blockedCount} 叶未过，装订暂缓`
      "
    >
      <template v-if="!gate.ready && gate.needCount > 0">
        <span v-for="block in gate.blocks" :key="block.leafNo" style="margin-right: 14px; white-space: nowrap">
          第 {{ block.leafNo }} 叶：{{ GATE_BLOCK_LABEL[block.reason] }}
        </span>
      </template>
    </el-alert>

    <div class="gb-stat-row">
      <StatBadge label="待处理 / 未合格" :value="deacidStore.pendingCount" suffix="单" tone="warning" />
      <StatBadge label="复测合格" :value="deacidStore.passedCount" suffix="单" tone="success" />
      <StatBadge label="历史空单" :value="deacidStore.legacyPendingCount" suffix="单" tone="danger" />
      <StatBadge label="缺单叶号" :value="missingLeaves.length" suffix="叶" tone="danger" />
      <StatBadge label="对不上的单" :value="orphanOrders.length" suffix="单" tone="info" />
      <StatBadge
        v-if="gate"
        label="本册放行率"
        :value="`${gate.percent}%`"
        :percent="gate.percent"
        :tone="gate.ready ? 'success' : 'warning'"
      />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索叶号 / 处理人…"
      @change="handleFilterChange"
      @reset="url.reset()"
    >
      <template #actions>
        <el-button type="primary" :icon="DocumentAdd" :disabled="locked" @click="openCreate()">开脱酸单</el-button>
      </template>
    </FilterBar>

    <el-card shadow="never" style="margin-top: 16px">
      <template #header>
        <div style="display: flex; align-items: center; justify-content: space-between">
          <span>脱酸处理单{{ currentVolume ? ` · ${volumeLabel(currentVolume.id)}` : '' }}</span>
          <el-tag v-if="locked" type="warning" effect="plain" round>整册已装订锁定，只读</el-tag>
        </div>
      </template>

      <EmptyPanel
        v-if="leafGroups.length === 0 && missingInVolume.length === 0"
        title="该册还没有脱酸处理单"
        description="检测室对需脱酸叶（原值 pH < 6.5 或破损含酸化）开单，填写脱酸方式并登记复测 pH。"
        action-text="开脱酸单"
        size="small"
        @action="openCreate()"
      />

      <el-table v-else :data="leafGroups" size="small" border>
        <el-table-column label="叶号" width="130">
          <template #default="{ row }">
            <strong>第 {{ row.leafNo }} 叶</strong>
            <el-tag v-if="blocksByLeafNo.get(row.leafNo)" type="danger" effect="plain" size="small" round style="margin-left: 4px">
              {{ GATE_BLOCK_LABEL[(blocksByLeafNo.get(row.leafNo) as GateBlockItem).reason] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="修复室原值" width="200">
          <template #default="{ row }">
            <span v-if="row.leaves.length > 0">
              <el-tag
                v-for="leaf in (row as LeafGroupRow).leaves"
                :key="leaf.id"
                size="small"
                effect="plain"
                round
                style="margin: 2px"
              >
                {{ damageLabel(leaf.damageType) }} · pH {{ leaf.phValue }}
              </el-tag>
            </span>
            <el-tag v-else type="info" effect="plain" size="small" round>修复室无此叶号</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="处理次数" width="90">
          <template #default="{ row }">{{ (row as LeafGroupRow).chain.length }} 次</template>
        </el-table-column>
        <el-table-column label="最新状态" width="130">
          <template #default="{ row }">
            <el-tag
              :style="{
                color: deacidStateColor((row as LeafGroupRow).latest.state),
                borderColor: `${deacidStateColor((row as LeafGroupRow).latest.state)}66`
              }"
              effect="plain"
              round
            >
              {{ deacidStateLabel((row as LeafGroupRow).latest.state) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="脱酸方式" width="110">
          <template #default="{ row }">{{ methodLabel((row as LeafGroupRow).latest.method) }}</template>
        </el-table-column>
        <el-table-column label="复测 pH" width="150">
          <template #default="{ row }">
            <span v-if="(row as LeafGroupRow).latest.retestPh !== null">
              {{ (row as LeafGroupRow).latest.retestPh }}
              <el-tag :type="(row as LeafGroupRow).latest.state === 'passed' ? 'success' : 'danger'" effect="plain" size="small" round>
                {{ (row as LeafGroupRow).latest.state === 'passed' ? '达标' : '不合格' }}
              </el-tag>
            </span>
            <span v-else class="gb-muted">未复测</span>
          </template>
        </el-table-column>
        <el-table-column label="来源 / 处理人" width="150">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" round>{{ sourceLabel((row as LeafGroupRow).latest.source) }}</el-tag>
            <span style="margin-left: 6px">{{ (row as LeafGroupRow).latest.operator || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="250">
          <template #default="{ row }">
            <el-button
              v-if="(row as LeafGroupRow).latest.state === 'pending' || (row as LeafGroupRow).latest.state === 'failed'"
              size="small"
              text
              type="primary"
              @click="openTreat((row as LeafGroupRow).latest)"
            >
              {{ (row as LeafGroupRow).latest.state === 'failed' ? '补录返工方式' : '补录脱酸方式' }}
            </el-button>
            <el-button
              v-if="(row as LeafGroupRow).latest.state === 'treated'"
              size="small"
              text
              type="primary"
              :icon="CircleCheck"
              @click="openRetest((row as LeafGroupRow).latest)"
            >
              复测
            </el-button>
            <el-button
              v-if="(row as LeafGroupRow).latest.state === 'failed'"
              size="small"
              text
              type="warning"
              :icon="RefreshRight"
              @click="retry((row as LeafGroupRow).latest)"
            >
              返工整单
            </el-button>
            <el-button
              size="small"
              text
              type="danger"
              :icon="Delete"
              :disabled="locked"
              @click="removeOrder((row as LeafGroupRow).latest)"
            >
              删单
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <!-- 缺单：修复室有需脱酸叶，检测室没单 -->
      <el-alert
        v-if="missingInVolume.length > 0"
        type="warning"
        show-icon
        :closable="false"
        style="margin-top: 12px"
        title="按叶号对账：以下叶修复室已登记酸化、检测室还没有处理单"
      >
        <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center">
          <el-tag
            v-for="item in missingInVolume"
            :key="`${item.volumeId}-${item.leafNo}`"
            type="warning"
            effect="plain"
            round
          >
            第 {{ item.leafNo }} 叶 · {{ needsTag(item.ph) }}
            <el-button text size="small" type="primary" @click="createForMissing(item.leafNo)">开单</el-button>
          </el-tag>
        </div>
      </el-alert>
    </el-card>

    <!-- 全库对账：对不上的先摆出来等人认领 -->
    <el-card shadow="never" style="margin-top: 16px">
      <template #header>
        <div style="display: flex; align-items: center; gap: 8px">
          <el-icon><Aim /></el-icon>
          <span>按叶号对账（全库）</span>
          <el-tag type="danger" effect="plain" size="small" round>缺单 {{ missingLeaves.length }} 叶</el-tag>
          <el-tag type="info" effect="plain" size="small" round>对不上的处理单 {{ orphanOrders.length }} 张</el-tag>
        </div>
      </template>

      <p class="gb-muted">两边各记各的，系统不自动改写；先把叶号摆出来，等检测室 / 修复室人工认领。</p>

      <el-table v-if="orphanOrders.length > 0" :data="orphanOrders" size="small" border>
        <el-table-column label="处理单号" min-width="180">
          <template #default="{ row }">{{ row.order.id }}</template>
        </el-table-column>
        <el-table-column label="单据所写册叶" width="200">
          <template #default="{ row }">
            {{ volumeLabel(row.order.volumeId) }} · 第 {{ row.order.leafNo }} 叶
            <el-tag size="small" effect="plain" round style="margin-left: 4px">
              {{ row.kind === 'dangling' ? '书叶记录缺失（悬挂）' : '叶号对不上' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="原值 / 复测" width="140">
          <template #default="{ row }">
            原值 {{ row.order.originalPh ?? '—' }} ／ 复测 {{ row.order.retestPh ?? '未测' }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-button size="small" text type="primary" :icon="WarningFilled" @click="openClaim(row)">
              认领重挂
            </el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="removeOrder(row.order)">删单</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="没有对不上的处理单" :image-size="60" />
    </el-card>

    <!-- 开单对话框 -->
    <el-dialog v-model="createDialog" title="检测室开脱酸处理单" width="520px">
      <el-form label-width="100px">
        <el-form-item label="叶号" required>
          <el-select v-model="createForm.leafNo" style="width: 100%" placeholder="选择需脱酸叶号">
            <el-option
              v-for="item in openableLeafNos"
              :key="item.leafNo"
              :label="`第 ${item.leafNo} 叶 · 原值 pH ${item.ph ?? '—'}`"
              :value="item.leafNo"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="脱酸方式" required>
          <el-select v-model="createForm.method" style="width: 100%">
            <el-option v-for="item in DEACID_METHOD_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="处理人">
          <el-input v-model="createForm.operator" placeholder="如：韩芷" />
        </el-form-item>
        <el-form-item label="处理日期">
          <el-input v-model="createForm.treatedDate" type="date" />
        </el-form-item>
      </el-form>
      <el-alert type="info" show-icon :closable="false" title="开单后状态为「已脱酸待复测」；复测 pH 只记入本单，不覆盖修复室原值。" />
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">开单</el-button>
      </template>
    </el-dialog>

    <!-- 补录方式对话框 -->
    <el-dialog v-model="treatDialog" title="补录脱酸方式" width="520px">
      <el-form label-width="100px" v-if="treatTarget">
        <el-form-item label="叶号">
          <span>第 {{ treatTarget.leafNo }} 叶 · 第 {{ treatTarget.attempt }} 次处理</span>
        </el-form-item>
        <el-form-item label="脱酸方式" required>
          <el-select v-model="treatForm.method" style="width: 100%">
            <el-option v-for="item in DEACID_METHOD_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="处理人">
          <el-input v-model="treatForm.operator" placeholder="如：韩芷" />
        </el-form-item>
        <el-form-item label="处理日期">
          <el-input v-model="treatForm.treatedDate" type="date" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="treatDialog = false">取消</el-button>
        <el-button type="primary" @click="submitTreat">保存待复测</el-button>
      </template>
    </el-dialog>

    <!-- 复测对话框 -->
    <el-dialog v-model="retestDialog" title="复测 pH 登记" width="520px">
      <el-form label-width="100px" v-if="retestTarget">
        <el-form-item label="叶号">
          <span>第 {{ retestTarget.leafNo }} 叶 · 原值 pH {{ retestTarget.originalPh ?? '—' }} · {{ retestTarget.method ? DEACID_METHOD_LABEL[retestTarget.method] : '' }}</span>
        </el-form-item>
        <el-form-item label="复测 pH" required>
          <el-input-number v-model="retestForm.retestPh" :min="3" :max="10" :step="0.1" :precision="1" />
          <span class="gb-muted" style="margin-left: 8px">合格区间 {{ DEACID_RETEST_MIN }}–{{ DEACID_RETEST_MAX }}</span>
        </el-form-item>
        <el-form-item label="复测日期">
          <el-input v-model="retestForm.retestDate" type="date" />
        </el-form-item>
      </el-form>
      <el-alert
        :type="retestForm.retestPh >= DEACID_RETEST_MIN && retestForm.retestPh <= DEACID_RETEST_MAX ? 'success' : 'error'"
        show-icon
        :closable="false"
        :title="
          retestForm.retestPh >= DEACID_RETEST_MIN && retestForm.retestPh <= DEACID_RETEST_MAX
            ? '复测达标：该叶在脱酸闸门放行'
            : '复测不合格：退回检测室，可另开返工单重试，修复室记录不动'
        "
      />
      <template #footer>
        <el-button @click="retestDialog = false">取消</el-button>
        <el-button type="primary" @click="submitRetest">提交复测</el-button>
      </template>
    </el-dialog>

    <!-- 认领对话框 -->
    <el-dialog v-model="claimDialog" title="对不上的处理单 · 认领重挂" width="520px">
      <el-form label-width="100px" v-if="claimTarget">
        <el-form-item label="处理单">
          <span>{{ volumeLabel(claimTarget.order.volumeId) }} 第 {{ claimTarget.order.leafNo }} 叶</span>
        </el-form-item>
        <el-form-item label="认领为">
          <el-select v-model="claimLeafId" style="width: 100%" :placeholder="claimTarget.candidates.length > 0 ? '选择同叶号书叶记录' : '同叶号无候选，需先回修复室核对'">
            <el-option
              v-for="leaf in claimTarget.candidates"
              :key="leaf.id"
              :label="`第 ${leaf.leafNo} 叶 · ${DAMAGE_TYPE_LABEL[leaf.damageType]} · pH ${leaf.phValue}`"
              :value="leaf.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert v-if="claimTarget && claimTarget.candidates.length === 0" type="warning" show-icon :closable="false" title="该叶号在修复室台账中找不到候选，单据只读留着继续等人核对。" />
      <template #footer>
        <el-button @click="claimDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!claimLeafId" @click="submitClaim">确认认领</el-button>
      </template>
    </el-dialog>
  </div>
</template>
