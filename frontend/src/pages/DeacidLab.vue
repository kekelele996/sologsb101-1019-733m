<script setup lang="ts">
/**
 * /deacid 脱酸台账与对账（保护科技检测室）
 * 检测室独立台账：处理单按叶号登记脱酸方式与复测 pH；复测不合格退回返工，
 * 检测室按本侧重试（轮次递增），修复室的工序记录不动。
 * 修复室书叶上的 pH 始终是送检前原值，本页复测值不回写。
 * 对账区把两边对不上的叶号摆出来等人认领。
 * 消费 DeacidRecord、Leaf、Volume；复用 <StatBadge>、<EmptyPanel>。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Plus } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useDeacidStore } from '@/stores/deacidStore'
import {
  DEACID_METHOD_LABEL,
  DEACID_METHOD_OPTIONS,
  DEACID_SOURCE_LABEL,
  DEACID_STATE_COLOR,
  DEACID_STATE_LABEL,
  type DeacidMethod,
  type DeacidRecord,
  type DeacidAttempt
} from '@/types/deacidRecord'
import { BINDING_TYPE_LABEL, VOLUME_STATE_LABEL } from '@/types/volume'
import {
  PH_PASS_MIN,
  checkVolumeDeacid,
  deacidStateOf,
  isPassPh,
  latestAttempt,
  reconcileByLeafNo
} from '@/utils/deacid'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const deacidStore = useDeacidStore()

/* ----------------------------- 册次选择 ----------------------------- */
const volumeId = ref<string>(bookStore.currentVolumeId ?? '')

const volumeOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).map((volume) => ({
      value: volume.id,
      label: `《${book.title}》第 ${volume.volumeNo} 册 · ${BINDING_TYPE_LABEL[volume.bindingType]} · ${VOLUME_STATE_LABEL[volume.state]}`
    }))
  )
)

watch(
  volumeOptions,
  (list) => {
    if (list.length === 0) {
      volumeId.value = ''
      return
    }
    if (!list.some((item) => item.value === volumeId.value)) {
      volumeId.value = list[0]?.value ?? ''
    }
  },
  { immediate: true }
)

const volumeLeaves = computed(() => (volumeId.value ? leafStore.leavesOfVolume(volumeId.value) : []))
const volumeRecords = computed(() => (volumeId.value ? deacidStore.recordsOfVolume(volumeId.value) : []))
const check = computed(() => checkVolumeDeacid(volumeLeaves.value, volumeRecords.value))
const reconcile = computed(() => reconcileByLeafNo(volumeLeaves.value, volumeRecords.value))
const reconcileClean = computed(
  () =>
    reconcile.value.missingInLab.length === 0 &&
    reconcile.value.extraInLab.length === 0 &&
    reconcile.value.duplicated.length === 0
)

/** 待认领叶号对应的处理单（台账有、修复室查无此叶） */
const extraRecords = computed(() =>
  volumeRecords.value.filter((record) => reconcile.value.extraInLab.includes(record.leafNo))
)

/* ----------------------------- 新建处理单（检测登记） ----------------------------- */
const sheetDialog = ref(false)
const sheetForm = reactive({ volumeId: '', leafNo: 1 })

const sheetPrePh = computed<number | null>(() => {
  if (!sheetForm.volumeId) return null
  const leaf = leafStore.leavesOfVolume(sheetForm.volumeId).find((item) => item.leafNo === sheetForm.leafNo)
  return leaf ? leaf.phValue : null
})

const sheetDuplicate = computed(() =>
  sheetForm.volumeId ? deacidStore.recordOfLeafNo(sheetForm.volumeId, sheetForm.leafNo) !== undefined : false
)

function openSheet(): void {
  if (volumeOptions.value.length === 0) {
    ElMessage.warning('请先在古籍台账中登记册次')
    return
  }
  sheetForm.volumeId = volumeId.value || (volumeOptions.value[0]?.value ?? '')
  sheetForm.leafNo = 1
  sheetDialog.value = true
}

async function submitSheet(): Promise<void> {
  if (!sheetForm.volumeId) {
    ElMessage.warning('请选择册次')
    return
  }
  if (sheetDuplicate.value) {
    ElMessage.error(`第 ${sheetForm.leafNo} 叶已有处理单，同一叶号不重复立单`)
    return
  }
  await deacidStore.registerSheet({
    volumeId: sheetForm.volumeId,
    leafNo: sheetForm.leafNo,
    prePh: sheetPrePh.value,
    source: 'register',
    attempts: []
  })
  ElMessage.success(
    sheetPrePh.value === null
      ? `已立第 ${sheetForm.leafNo} 叶处理单；修复室查无此叶，已列入对账待认领`
      : `已立第 ${sheetForm.leafNo} 叶处理单，送检前原值 pH ${sheetPrePh.value} 已快照`
  )
  sheetDialog.value = false
}

/* ----------------------------- 登记处理与复测（含返工重试） ----------------------------- */
const attemptDialog = ref(false)
const attemptTarget = ref<DeacidRecord | null>(null)
const attemptForm = reactive({
  method: 'aqueous' as DeacidMethod,
  retestPh: 7.2,
  operator: '',
  date: new Date().toISOString().slice(0, 10),
  note: ''
})

const attemptRound = computed(() => (attemptTarget.value ? attemptTarget.value.attempts.length + 1 : 1))
const attemptPass = computed(() => isPassPh(attemptForm.retestPh))

function openAttempt(record: DeacidRecord): void {
  attemptTarget.value = record
  attemptForm.method = 'aqueous'
  attemptForm.retestPh = 7.2
  attemptForm.operator = ''
  attemptForm.date = new Date().toISOString().slice(0, 10)
  attemptForm.note = ''
  attemptDialog.value = true
}

async function submitAttempt(): Promise<void> {
  const target = attemptTarget.value
  if (!target) return
  const attempt = await deacidStore.appendAttempt(target.id, { ...attemptForm })
  if (!attempt) return
  ElMessage[attempt.pass ? 'success' : 'warning'](
    attempt.pass
      ? `第 ${target.leafNo} 叶第 ${attempt.round} 轮复测 pH ${attempt.retestPh}，达标`
      : `第 ${target.leafNo} 叶第 ${attempt.round} 轮复测 pH ${attempt.retestPh}，未达标已退回返工（修复室工序记录不动）`
  )
  attemptDialog.value = false
}

/* ----------------------------- 删除处理单（对账认领清理） ----------------------------- */
async function removeRecord(record: DeacidRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将删除第 ${record.leafNo} 叶的脱酸处理单（共 ${record.attempts.length} 轮记录），不影响修复室的书叶与工序台账。`,
      '删除处理单',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await deacidStore.removeRecord(record.id)
  ElMessage.success('已删除处理单')
}

/* ----------------------------- 展示辅助 ----------------------------- */
function stateTag(record: DeacidRecord): { label: string; color: string } {
  const state = deacidStateOf(record)
  return { label: DEACID_STATE_LABEL[state], color: DEACID_STATE_COLOR[state] }
}

function methodText(record: DeacidRecord): string {
  const last = latestAttempt(record)
  return last ? DEACID_METHOD_LABEL[last.method] : '—'
}

function attemptMethodText(attempt: DeacidAttempt): string {
  return DEACID_METHOD_LABEL[attempt.method]
}

function sourceText(record: DeacidRecord): string {
  return DEACID_SOURCE_LABEL[record.source]
}

function retestText(record: DeacidRecord): string {
  const last = latestAttempt(record)
  return last ? String(last.retestPh) : '—'
}

function attemptButtonText(record: DeacidRecord): string {
  if (record.attempts.length === 0) return '登记处理'
  return deacidStateOf(record) === 'reworking' ? '返工重试' : '再处理'
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>脱酸台账与对账</h2>
        <p>
          检测室独立记账：处理单写清每叶的脱酸方式与复测 pH（达标线 pH ≥ {{ PH_PASS_MIN }}）；复测不合格退回返工、按本侧重试，修复室工序记录不动。
        </p>
      </div>
      <div class="gb-toolbar">
        <el-button type="primary" :icon="Plus" @click="openSheet">新建处理单</el-button>
      </div>
    </div>

    <el-card shadow="never" style="margin-bottom: 14px">
      <div class="gb-toolbar">
        <span class="gb-muted">册次：</span>
        <el-select v-model="volumeId" style="width: 380px" placeholder="选择册次">
          <el-option v-for="item in volumeOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-tag effect="plain" round>台账 {{ volumeRecords.length }} 单</el-tag>
      </div>
      <el-alert
        v-if="check.totalLeafNos > 0 && check.ready"
        style="margin-top: 10px"
        type="success"
        show-icon
        :closable="false"
        :title="`全册 ${check.totalLeafNos} 叶复测全部达标，修复室可放行装订`"
      />
      <el-alert
        v-else-if="check.totalLeafNos > 0"
        style="margin-top: 10px"
        type="warning"
        show-icon
        :closable="false"
        title="复测未齐，补齐前修复室不放行装订"
        :description="`已达标 ${check.passed} 叶 · 待处理 ${check.pending} 叶 · 返工中 ${check.reworking} 叶 · 未立单 ${check.missing} 叶`"
      />
      <el-alert
        v-else
        style="margin-top: 10px"
        type="info"
        show-icon
        :closable="false"
        title="该册修复室尚未登记书叶"
      />
    </el-card>

    <div class="gb-stat-row">
      <StatBadge label="处理单" :value="volumeRecords.length" suffix="份" tone="primary" />
      <StatBadge label="已达标" :value="check.passed" suffix="叶" tone="success" />
      <StatBadge label="待处理" :value="check.pending" suffix="叶" />
      <StatBadge label="返工中" :value="check.reworking" suffix="叶" tone="warning" />
      <StatBadge label="未立单" :value="check.missing" suffix="叶" tone="danger" />
      <StatBadge label="待认领叶号" :value="reconcile.extraInLab.length" suffix="个" tone="info" />
    </div>

    <el-card shadow="never" style="margin-top: 16px">
      <template #header>脱酸处理单（检测室台账）</template>
      <EmptyPanel
        v-if="volumeRecords.length === 0"
        title="该册还没有脱酸处理单"
        description="按叶号立单，登记每叶的脱酸方式与复测 pH；送检前原值 pH 自动从修复室登记快照，只抄不盖。"
        action-text="新建处理单"
        size="small"
        @action="openSheet"
      />
      <el-table v-else :data="volumeRecords" size="small" border>
        <el-table-column type="expand">
          <template #default="{ row }">
            <div style="padding: 8px 24px">
              <p v-if="row.attempts.length === 0" class="gb-muted" style="margin: 4px 0">
                检测室那份还留空，待登记第一轮处理与复测。
              </p>
              <el-table v-else :data="row.attempts" size="small" border>
                <el-table-column prop="round" label="轮次" width="70" />
                <el-table-column label="脱酸方式" width="140">
                  <template #default="{ row: attempt }">{{ attemptMethodText(attempt) }}</template>
                </el-table-column>
                <el-table-column prop="retestPh" label="复测 pH" width="100" />
                <el-table-column label="结论" width="90">
                  <template #default="{ row: attempt }">
                    <el-tag :type="attempt.pass ? 'success' : 'danger'" effect="plain" size="small" round>
                      {{ attempt.pass ? '达标' : '未达标' }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="operator" label="检测人" width="100" />
                <el-table-column prop="date" label="日期" width="110" />
                <el-table-column prop="note" label="备注" min-width="160" />
              </el-table>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="leafNo" label="叶号" width="80" sortable />
        <el-table-column label="来源" width="100">
          <template #default="{ row }">
            <el-tag effect="plain" size="small" round>{{ sourceText(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="送检前 pH（原值）" width="140">
          <template #default="{ row }">{{ row.prePh ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="最近脱酸方式" width="130">
          <template #default="{ row }">{{ methodText(row) }}</template>
        </el-table-column>
        <el-table-column label="最近复测 pH" width="120">
          <template #default="{ row }">{{ retestText(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :style="{ color: stateTag(row).color, borderColor: `${stateTag(row).color}66` }" effect="plain" round>
              {{ stateTag(row).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="轮次" width="80">
          <template #default="{ row }">{{ row.attempts.length }}</template>
        </el-table-column>
        <el-table-column label="操作" min-width="200">
          <template #default="{ row }">
            <el-button
              size="small"
              text
              type="primary"
              :disabled="deacidStateOf(row) === 'passed'"
              @click="openAttempt(row)"
            >
              {{ attemptButtonText(row) }}
            </el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="removeRecord(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" style="margin-top: 16px">
      <template #header>叶号对账（修复室 × 检测室）</template>
      <el-alert
        v-if="reconcileClean"
        type="success"
        show-icon
        :closable="false"
        title="账实相符：两边叶号全部对上"
      />
      <template v-else>
        <div class="reconcile-block">
          <p class="reconcile-block__title">修复室有、台账缺（{{ reconcile.missingInLab.length }}）</p>
          <p v-if="reconcile.missingInLab.length === 0" class="gb-muted">无</p>
          <template v-else>
            <el-tag v-for="no in reconcile.missingInLab" :key="no" style="margin: 0 6px 6px 0" effect="plain" round>
              第 {{ no }} 叶
            </el-tag>
            <p class="gb-muted">这些叶还没立处理单，可在右上方「新建处理单」送检登记。</p>
          </template>
        </div>
        <div class="reconcile-block">
          <p class="reconcile-block__title">台账有、修复室查无此叶 · 待认领（{{ extraRecords.length }}）</p>
          <p v-if="extraRecords.length === 0" class="gb-muted">无</p>
          <el-table v-else :data="extraRecords" size="small" border>
            <el-table-column prop="leafNo" label="叶号" width="90" />
            <el-table-column label="来源" width="110">
              <template #default="{ row }">{{ sourceText(row) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">{{ stateTag(row).label }}</template>
            </el-table-column>
            <el-table-column label="说明" min-width="200">
              <template #default>对不上的叶号先摆出来等人认领；确认多记可删除。</template>
            </el-table-column>
            <el-table-column label="操作" width="110">
              <template #default="{ row }">
                <el-button size="small" text type="danger" :icon="Delete" @click="removeRecord(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <div class="reconcile-block">
          <p class="reconcile-block__title">一叶多单（{{ reconcile.duplicated.length }}）</p>
          <p v-if="reconcile.duplicated.length === 0" class="gb-muted">无</p>
          <template v-else>
            <el-tag
              v-for="no in reconcile.duplicated"
              :key="no"
              style="margin: 0 6px 6px 0"
              type="warning"
              effect="plain"
              round
            >
              第 {{ no }} 叶
            </el-tag>
            <p class="gb-muted">同一叶号记了不止一单，请核实后保留一单。</p>
          </template>
        </div>
      </template>
    </el-card>

    <el-dialog v-model="sheetDialog" title="新建脱酸处理单（检测登记）" width="520px">
      <el-form label-width="130px">
        <el-form-item label="册次" required>
          <el-select v-model="sheetForm.volumeId" style="width: 100%">
            <el-option v-for="item in volumeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="叶号" required>
          <el-input-number v-model="sheetForm.leafNo" :min="1" :max="999" />
        </el-form-item>
        <el-form-item label="送检前 pH（原值）">
          <span v-if="sheetPrePh !== null">{{ sheetPrePh }}（自修复室登记快照，只抄不盖）</span>
          <span v-else class="gb-muted">修复室查无此叶，留空</span>
        </el-form-item>
      </el-form>
      <el-alert
        v-if="sheetDuplicate"
        type="error"
        show-icon
        :closable="false"
        :title="`第 ${sheetForm.leafNo} 叶已有处理单，同一叶号不重复立单`"
      />
      <el-alert
        v-else-if="sheetPrePh === null"
        type="warning"
        show-icon
        :closable="false"
        title="修复室查无此叶：保存后该单将列入对账「待认领」，等人核实"
      />
      <template #footer>
        <el-button @click="sheetDialog = false">取消</el-button>
        <el-button type="primary" :disabled="sheetDuplicate" @click="submitSheet">立单</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="attemptDialog"
      :title="`第 ${attemptTarget?.leafNo ?? ''} 叶 · 第 ${attemptRound} 轮处理与复测${attemptRound > 1 ? '（返工重试）' : ''}`"
      width="560px"
    >
      <el-form label-width="110px">
        <el-form-item label="脱酸方式" required>
          <el-select v-model="attemptForm.method" style="width: 100%">
            <el-option v-for="item in DEACID_METHOD_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="复测 pH" required>
          <el-input-number v-model="attemptForm.retestPh" :min="3" :max="10" :step="0.1" :precision="1" />
          <el-tag
            style="margin-left: 8px"
            :type="attemptPass ? 'success' : 'danger'"
            effect="plain"
            round
          >
            {{ attemptPass ? `达标（≥ ${PH_PASS_MIN}）` : `未达标（< ${PH_PASS_MIN}）` }}
          </el-tag>
        </el-form-item>
        <el-form-item label="检测人">
          <el-input v-model="attemptForm.operator" placeholder="如：韩澈" />
        </el-form-item>
        <el-form-item label="处理日期">
          <el-input v-model="attemptForm.date" type="date" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="attemptForm.note" placeholder="处理要点、返工原因等" />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="!attemptPass"
        type="warning"
        show-icon
        :closable="false"
        title="复测不合格将退回返工：检测室按本侧重试（轮次递增），修复室的工序记录不动"
      />
      <el-alert
        v-else
        type="success"
        show-icon
        :closable="false"
        title="复测达标后记入检测室台账；修复室书叶上的 pH 仍为送检前原值，不回写"
      />
      <template #footer>
        <el-button @click="attemptDialog = false">取消</el-button>
        <el-button type="primary" @click="submitAttempt">登记本轮</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.reconcile-block {
  margin-bottom: 14px;
}

.reconcile-block__title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: #2f2a24;
}
</style>
