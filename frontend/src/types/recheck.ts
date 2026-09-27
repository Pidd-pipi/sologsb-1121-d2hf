import type { TreeRecord } from './tree';

/** 生成比对时冻结的单期样木状态（用于后续失效检测） */
export interface RoundTreeState {
  treeNo: string;
  species: string;
  dbhCm: number;
  heightM: number;
  status: string;
}

/** 复查逐株比对结果 */
export interface RecheckDiff {
  id: string;
  plotId: string;
  /** 上期期次 */
  baseRound: number;
  /** 本期期次 */
  targetRound: number;
  /** 同一批生成/保存的比对共用的批次号 */
  batchId: string;
  treeNo: string;
  species: string;
  /** 上期胸径 cm（缺失期留空） */
  baseDbhCm?: number;
  /** 本期胸径 cm */
  targetDbhCm?: number;
  /** 上期树高 m */
  baseHeightM?: number;
  /** 本期树高 m */
  targetHeightM?: number;
  /** 胸径生长量 cm */
  dbhGrowth: number;
  /** 树高生长量 m */
  heightGrowth: number;
  /** 状态变化描述 */
  statusChange: string;
  /** 无法匹配时的缺失原因 */
  missingReason: string;
  /** 生成时的上期样木状态快照（老档案可能缺失） */
  baseState?: RoundTreeState;
  /** 生成时的本期样木状态快照（老档案可能缺失） */
  targetState?: RoundTreeState;
  generatedAt: number;
}

export type RecheckDiffDraft = Omit<RecheckDiff, 'id' | 'generatedAt'>;

/** 一批比对的概要信息 */
export interface RecheckBatchRef {
  batchId: string;
  plotId: string;
  baseRound: number;
  targetRound: number;
  generatedAt: number;
  rows: RecheckDiff[];
}

/** 保留木生长率：生长量 / 上期胸径 */
export function growthRate(diff: RecheckDiff): number {
  if (!diff.baseDbhCm || diff.baseDbhCm <= 0) return 0;
  return Math.round((diff.dbhGrowth / diff.baseDbhCm) * 10000) / 100;
}

/** 是否异常：生长量为负或缺测 */
export function isDiffAbnormal(diff: RecheckDiff): boolean {
  return diff.dbhGrowth < 0 || diff.heightGrowth < 0 || !diff.targetDbhCm;
}

/** 把已保存的比对行按批次归组，按生成时间倒序 */
export function groupRecheckBatches(rows: RecheckDiff[]): RecheckBatchRef[] {
  const map = new Map<string, RecheckBatchRef>();
  rows.forEach((row) => {
    const key = row.batchId || `legacy-${row.plotId}-${row.baseRound}-${row.targetRound}`;
    const batch =
      map.get(key) ??
      ({
        batchId: key,
        plotId: row.plotId,
        baseRound: row.baseRound,
        targetRound: row.targetRound,
        generatedAt: row.generatedAt,
        rows: [],
      } satisfies RecheckBatchRef);
    batch.rows.push(row);
    if (row.generatedAt > batch.generatedAt) batch.generatedAt = row.generatedAt;
    map.set(key, batch);
  });
  return Array.from(map.values()).sort((a, b) => b.generatedAt - a.generatedAt);
}

/**
 * 失效检测：比对批次生成后，其「上期/本期」样木是否又发生过变化。
 * 只比对批次自身的样地与两个期次，其他期次/样地的改动不影响结果。
 * 返回人类可读的失效原因列表，空数组表示仍然有效。
 */
export function checkRecheckDrift(batch: RecheckBatchRef, trees: TreeRecord[]): string[] {
  const reasons: string[] = [];
  const roundLabel = (round: number) => `第 ${round} 期`;

  // 老档案没有快照，无法核对，一律要求重新生成
  if (batch.rows.some((row) => !row.baseState && !row.targetState)) {
    reasons.push('该比对为旧版档案，未记录生成时的样木状态，需重新生成后才能使用');
    return reasons;
  }

  const relevant = trees.filter(
    (t) => t.plotId === batch.plotId && (t.round === batch.baseRound || t.round === batch.targetRound),
  );
  const current = new Map<string, TreeRecord>();
  relevant.forEach((t) => current.set(`${t.round}::${t.treeNo}`, t));

  const snapNos = new Set<string>();
  batch.rows.forEach((row) => {
    if (row.baseState) snapNos.add(`${batch.baseRound}::${row.baseState.treeNo}`);
    if (row.targetState) snapNos.add(`${batch.targetRound}::${row.targetState.treeNo}`);
  });

  const added = relevant.filter((t) => !snapNos.has(`${t.round}::${t.treeNo}`));
  if (added.length > 0) {
    const nos = added.map((t) => `${roundLabel(t.round)} ${t.treeNo} 号`).join('、');
    reasons.push(`新增样木未纳入比对：${nos}`);
  }

  const checkSide = (round: number, snap: RoundTreeState | undefined) => {
    if (!snap) return;
    const cur = current.get(`${round}::${snap.treeNo}`);
    const label = `${roundLabel(round)} ${snap.treeNo} 号`;
    if (!cur) {
      reasons.push(`${label}已被删除`);
      return;
    }
    if (cur.species !== snap.species) reasons.push(`${label}树种由「${snap.species}」改为「${cur.species}」`);
    if (cur.dbhCm !== snap.dbhCm) reasons.push(`${label}胸径由 ${snap.dbhCm} 改为 ${cur.dbhCm} cm`);
    if (cur.heightM !== snap.heightM) reasons.push(`${label}树高由 ${snap.heightM} 改为 ${cur.heightM} m`);
    if (cur.status !== snap.status) reasons.push(`${label}树况由「${snap.status}」改为「${cur.status}」`);
  };

  batch.rows.forEach((row) => {
    checkSide(batch.baseRound, row.baseState);
    checkSide(batch.targetRound, row.targetState);
  });

  return reasons;
}
