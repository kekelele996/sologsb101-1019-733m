/**
 * 脱酸处理单（DeacidRecord）数据模型
 * 保护科技检测室独立台账：按叶号登记每叶的脱酸方式与复测 pH。
 * 与修复室的书叶破损登记各记各的——书叶上的 pH 永远是送检前原值，
 * 复测值只落在本台账，两边按叶号对账。
 */

/** 脱酸方式：水溶液脱酸 / 非水脱酸 / 气相脱酸 / 碱性氧化物沉积 */
export type DeacidMethod = 'aqueous' | 'nonAqueous' | 'gasPhase' | 'alkaline';

/** 处理单来源：历史拆分（升级时按原值 pH 拆出）/ 检测登记（检测室新立） */
export type DeacidSource = 'history' | 'register';

/** 处理单状态（由最近一轮复测派生，不落库）：待处理 / 返工中 / 已达标 */
export type DeacidState = 'pending' | 'reworking' | 'passed';

/** 一轮脱酸处理与复测；复测不合格退回检测室后按本侧重试，轮次递增 */
export interface DeacidAttempt {
  /** 第几轮处理，从 1 开始 */
  round: number;
  /** 脱酸方式 */
  method: DeacidMethod;
  /** 复测 pH */
  retestPh: number;
  /** 本轮复测是否达标 */
  pass: boolean;
  /** 检测人 */
  operator: string;
  /** 处理日期 yyyy-MM-dd */
  date: string;
  /** 备注 */
  note: string;
}

export interface DeacidRecord {
  id: string;
  /** 所属册次 id */
  volumeId: string;
  /** 叶号：检测室按叶号记账，也是对账关键字 */
  leafNo: number;
  /** 送检前原值 pH 快照（抄自修复室登记，只抄不盖） */
  prePh: number | null;
  /** 来源 */
  source: DeacidSource;
  /** 逐轮处理与复测记录；空数组表示检测室那份还留空 */
  attempts: DeacidAttempt[];
  createdAt: number;
  updatedAt: number;
}

export type DeacidRecordDraft = Omit<DeacidRecord, 'id' | 'createdAt' | 'updatedAt' | 'attempts'> & {
  attempts?: DeacidAttempt[];
};

export const DEACID_METHOD_LABEL: Record<DeacidMethod, string> = {
  aqueous: '水溶液脱酸',
  nonAqueous: '非水脱酸',
  gasPhase: '气相脱酸',
  alkaline: '碱性氧化物沉积',
};

export const DEACID_METHOD_OPTIONS: ReadonlyArray<{ value: DeacidMethod; label: string }> = [
  { value: 'aqueous', label: '水溶液脱酸' },
  { value: 'nonAqueous', label: '非水脱酸' },
  { value: 'gasPhase', label: '气相脱酸' },
  { value: 'alkaline', label: '碱性氧化物沉积' },
];

export const DEACID_SOURCE_LABEL: Record<DeacidSource, string> = {
  history: '历史拆分',
  register: '检测登记',
};

export const DEACID_STATE_LABEL: Record<DeacidState, string> = {
  pending: '待处理',
  reworking: '返工中',
  passed: '已达标',
};

export const DEACID_STATE_COLOR: Record<DeacidState, string> = {
  pending: '#8c8c8c',
  reworking: '#d68910',
  passed: '#1e8449',
};

export function createEmptyDeacidDraft(volumeId: string, leafNo: number, prePh: number | null): DeacidRecordDraft {
  return {
    volumeId,
    leafNo,
    prePh,
    source: 'register',
    attempts: [],
  };
}
