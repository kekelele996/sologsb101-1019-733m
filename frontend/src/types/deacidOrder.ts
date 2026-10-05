/**
 * 脱酸处理单（DeacidOrder）数据模型 —— 保护科技检测室台账
 * 与修复室的书叶破损台账（Leaf）各记各的：
 * - 处理单只写检测室侧的数据：脱酸方式、复测 pH、处理人与结论；
 * - 复测值不回盖修复室 Leaf.phValue（那是送检前原值）；
 * - 复测不合格退回检测室返工，按本侧规则「新增一张处理单」重试，
 *   修复室的修复工序记录（RepairOrder）不动。
 * 粒度为物理叶（一册一叶号一单链），按 volumeId + leafNo 与修复室对账。
 */

/** 脱酸方式：液相脱酸 / 气相脱酸 / 加固脱酸 / 无水脱酸 */
export type DeacidMethod = 'liquid' | 'vapor' | 'reinforce' | 'nonaqueous';

/**
 * 处理单状态：
 * - pending   待处理（历史拆单 / 新开单尚未脱酸）
 * - treated   已脱酸待复测
 * - passed    复测合格（pH 回到 6.5–8.5）
 * - failed    复测不合格，退回检测室按本侧重试
 */
export type DeacidState = 'pending' | 'treated' | 'passed' | 'failed';

/** 单据来源：normal 检测室正常开单；legacy v2→v3 升级时按原值 pH 拆出的历史单 */
export type DeacidSource = 'normal' | 'legacy';

export interface DeacidOrder {
  id: string;
  /** 所属册次 id（快照，处理单保留册次与叶号，书叶被删后仍可摆出对账） */
  volumeId: string;
  /** 叶号（对账键） */
  leafNo: number;
  /** 关联修复室书叶记录 id；悬挂单（书叶记录缺失 / 对不上）时为 null */
  leafId: string | null;
  /** 送检前原值 pH（自修复室台账快照）；历史数据无有效 pH 时为 null */
  originalPh: number | null;
  /** 脱酸方式；历史拆单在复测补齐前留空 */
  method: DeacidMethod | null;
  /** 处理人 */
  operator: string;
  /** 脱酸处理日期 yyyy-MM-dd */
  treatedDate: string;
  /** 复测 pH；未复测 / 历史空单为 null */
  retestPh: number | null;
  /** 复测日期 yyyy-MM-dd */
  retestDate: string;
  /** 当前状态 */
  state: DeacidState;
  /** 单据来源 */
  source: DeacidSource;
  /** 第几次处理（同一叶号返工重试自增，从 1 开始） */
  attempt: number;
  /** 备注（返工原因等） */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

export type DeacidOrderDraft = Omit<DeacidOrder, 'id' | 'createdAt' | 'updatedAt'>;

export const DEACID_METHOD_LABEL: Record<DeacidMethod, string> = {
  liquid: '液相脱酸',
  vapor: '气相脱酸',
  reinforce: '加固脱酸',
  nonaqueous: '无水脱酸'
};

export const DEACID_METHOD_OPTIONS: ReadonlyArray<{ value: DeacidMethod; label: string }> = [
  { value: 'liquid', label: '液相脱酸' },
  { value: 'vapor', label: '气相脱酸' },
  { value: 'reinforce', label: '加固脱酸' },
  { value: 'nonaqueous', label: '无水脱酸' }
];

export const DEACID_STATE_LABEL: Record<DeacidState, string> = {
  pending: '待处理',
  treated: '已脱酸待复测',
  passed: '复测合格',
  failed: '复测不合格'
};

export const DEACID_STATE_COLOR: Record<DeacidState, string> = {
  pending: '#8c8c8c',
  treated: '#d68910',
  passed: '#1e8449',
  failed: '#b03a2e'
};

export const DEACID_STATE_OPTIONS: ReadonlyArray<{ value: DeacidState; label: string }> = [
  { value: 'pending', label: '待处理' },
  { value: 'treated', label: '已脱酸待复测' },
  { value: 'passed', label: '复测合格' },
  { value: 'failed', label: '复测不合格' }
];

export const DEACID_SOURCE_LABEL: Record<DeacidSource, string> = {
  normal: '检测室开单',
  legacy: '历史拆单'
};

/** 需脱酸判定：修复室原值 pH 低于 6.5 视为酸化，须送检脱酸 */
export const DEACID_TRIGGER_PH = 6.5;

/** 复测合格区间：6.5 ≤ pH ≤ 8.5（中性至弱碱） */
export const DEACID_RETEST_MIN = 6.5;
export const DEACID_RETEST_MAX = 8.5;

/** pH 是否为可判定的有效数值（旧数据拆不出时为 null） */
export function isValidPh(ph: unknown): ph is number {
  return typeof ph === 'number' && Number.isFinite(ph)
}

/** 该原值 pH 是否需要脱酸处理 */
export function needsDeacid(ph: number | null): boolean {
  return ph !== null && isValidPh(ph) && ph < DEACID_TRIGGER_PH
}

/** 复测结论判定 */
export function retestVerdict(retestPh: number | null): 'pass' | 'fail' | 'none' {
  if (retestPh === null || !isValidPh(retestPh)) return 'none'
  if (retestPh >= DEACID_RETEST_MIN && retestPh <= DEACID_RETEST_MAX) return 'pass'
  return 'fail'
}

export function deacidStateLabel(state: string): string {
  return DEACID_STATE_LABEL[state as DeacidState] ?? state
}

export function deacidStateColor(state: string): string {
  return DEACID_STATE_COLOR[state as DeacidState] ?? '#8c8c8c'
}

/** 检测室新开处理单草稿（pending） */
export function createEmptyOrderDraft(volumeId: string, leafNo: number, leafId: string | null, originalPh: number | null, attempt: number): DeacidOrderDraft {
  return {
    volumeId,
    leafNo,
    leafId,
    originalPh,
    method: null,
    operator: '',
    treatedDate: new Date().toISOString().slice(0, 10),
    retestPh: null,
    retestDate: '',
    state: 'pending',
    source: 'normal',
    attempt,
    remark: ''
  }
}
