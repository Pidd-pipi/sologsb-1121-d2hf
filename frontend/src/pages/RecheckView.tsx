import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { SaveOutlined, WarningOutlined } from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import GrowthDiffTable from '../components/common/GrowthDiffTable';
import RoundTag from '../components/common/RoundTag';
import { loadRecheckDiffs, saveRecheckBatch } from '../utils/db';
import { newId } from '../utils/id';
import {
  checkRecheckDrift,
  groupRecheckBatches,
  growthRate,
  isDiffAbnormal,
  type RecheckBatchRef,
  type RecheckDiff,
  type RoundTreeState,
} from '../types/recheck';
import type { TreeRecord } from '../types/tree';

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** /plots/:id/recheck 复查比对：逐株显示两期胸径/树高与生长量，标记缺失与状态变化 */
export default function RecheckView() {
  const { id = '' } = useParams();
  const plot = usePlotStore((s) => s.items.find((p) => p.id === id));
  const trees = useTreeStore((s) => s.items);

  const rounds = useMemo(
    () => Array.from(new Set(trees.filter((t) => t.plotId === id).map((t) => t.round))).sort((a, b) => a - b),
    [trees, id],
  );

  const [baseRound, setBaseRound] = useState<number>(rounds[0] ?? 1);
  const [targetRound, setTargetRound] = useState<number>(rounds[rounds.length - 1] ?? 2);
  /** 本次会话内生成、尚未保存的比对；切换期次或保存后清空，回退到已保存批次 */
  const [drafts, setDrafts] = useState<RecheckDiff[] | null>(null);
  const [savedRows, setSavedRows] = useState<RecheckDiff[]>([]);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (rounds.length >= 2) {
      setBaseRound(rounds[rounds.length - 2]);
      setTargetRound(rounds[rounds.length - 1]);
    }
  }, [rounds.join(',')]);

  useEffect(() => {
    if (!id) return;
    void loadRecheckDiffs(id).then(setSavedRows);
  }, [id]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const batches = useMemo(() => groupRecheckBatches(savedRows), [savedRows]);
  const savedBatch = useMemo(
    () => batches.find((b) => b.baseRound === baseRound && b.targetRound === targetRound) ?? null,
    [batches, baseRound, targetRound],
  );

  const diffs = drafts ?? savedBatch?.rows ?? [];

  const activeBatch: RecheckBatchRef | null = useMemo(() => {
    if (diffs.length === 0) return null;
    return {
      batchId: diffs[0].batchId,
      plotId: diffs[0].plotId,
      baseRound: diffs[0].baseRound,
      targetRound: diffs[0].targetRound,
      generatedAt: Math.max(...diffs.map((d) => d.generatedAt)),
      rows: diffs,
    };
  }, [diffs]);

  /** 与当前样木逐株核对快照：只有本批次的上期/本期样木参与比对，其他期次不影响 */
  const drift = useMemo(
    () => (activeBatch ? checkRecheckDrift(activeBatch, trees) : []),
    [activeBatch, trees],
  );
  const stale = drift.length > 0;

  const switchRound = (side: 'base' | 'target', value: number) => {
    if (side === 'base') setBaseRound(value);
    else setTargetRound(value);
    setDrafts(null);
    setError('');
  };

  const snapshot = (t?: TreeRecord): RoundTreeState | undefined =>
    t
      ? {
          treeNo: t.treeNo,
          species: t.species,
          dbhCm: t.dbhCm,
          heightM: t.heightM,
          status: t.status,
        }
      : undefined;

  const generate = () => {
    if (baseRound === targetRound) {
      setError('上期与本期不能是同一期次');
      return;
    }
    const baseList = trees.filter((t) => t.plotId === id && t.round === baseRound);
    const targetList = trees.filter((t) => t.plotId === id && t.round === targetRound);
    const baseMap = new Map<string, TreeRecord>();
    baseList.forEach((t) => baseMap.set(t.treeNo, t));
    const targetMap = new Map<string, TreeRecord>();
    targetList.forEach((t) => targetMap.set(t.treeNo, t));
    const allNos = Array.from(new Set([...baseMap.keys(), ...targetMap.keys()])).sort((a, b) =>
      a.localeCompare(b, 'zh-Hans-CN', { numeric: true }),
    );

    const batchId = newId('batch');
    const generatedAt = Date.now();
    const next: RecheckDiff[] = allNos.map((treeNo) => {
      const b = baseMap.get(treeNo);
      const t = targetMap.get(treeNo);
      const baseDbh = b?.dbhCm;
      const targetDbh = t?.dbhCm;
      const dbhGrowth =
        baseDbh !== undefined && targetDbh !== undefined ? r2(targetDbh - baseDbh) : 0;
      const heightGrowth =
        b && t ? r2(t.heightM - b.heightM) : 0;
      const statusChange = b && t && b.status !== t.status ? `${b.status} → ${t.status}` : '';
      const missingReason = !t ? '本期未复测（疑似采伐或倒伏）' : !b ? '本期新增进界木' : '';
      return {
        id: newId('diff'),
        plotId: id,
        baseRound,
        targetRound,
        batchId,
        treeNo,
        species: t?.species ?? b?.species ?? '',
        baseDbhCm: baseDbh,
        targetDbhCm: targetDbh,
        baseHeightM: b?.heightM,
        targetHeightM: t?.heightM,
        dbhGrowth,
        heightGrowth,
        statusChange,
        missingReason,
        baseState: snapshot(b),
        targetState: snapshot(t),
        generatedAt,
      };
    });

    setDrafts(next);
    setError('');
    setToast(`已生成第 ${baseRound} 期 → 第 ${targetRound} 期的逐株比对表，共 ${next.length} 条`);
  };

  const save = async () => {
    if (diffs.length === 0) {
      setError('请先生成比对表');
      return;
    }
    if (stale) return;
    await saveRecheckBatch(diffs);
    setSavedRows(await loadRecheckDiffs(id));
    setDrafts(null);
    setToast(`逐株比对表已写入本地档案库（${diffs.length} 条）`);
  };

  const abnormal = diffs.filter(isDiffAbnormal).length;
  const missing = diffs.filter((d) => !d.targetDbhCm).length;
  const retained = diffs.filter((d) => d.targetDbhCm);
  const avgRate = retained.length === 0 ? 0 : r2(retained.reduce((s, d) => s + growthRate(d), 0) / retained.length);

  if (!plot) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该样地" />
        <Link to="/plots">返回样地台账</Link>
      </Space>
    );
  }

  const saveButton = (
    <Button
      icon={<SaveOutlined />}
      onClick={save}
      disabled={diffs.length === 0 || stale}
    >
      保存比对结果
    </Button>
  );

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          复查比对 · {plot.plotNo}
        </Typography.Title>
        <RoundTag round={plot.surveyRound} locked={plot.locked} />
        <Tag>样地面积 {plot.area} m²</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/plots/${plot.id}/trees`}>样木录入</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/regen`}>更新与灌木</Link>
        </Button>
        <Button type="link">
          <Link to={`/summary/${plot.id}`}>林分汇总</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
      {stale ? (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message="比对结果已失效，待重新生成"
          description={
            <Space direction="vertical" size={4}>
              <Typography.Text>
                该比对生成后，第 {activeBatch?.baseRound} 期/第 {activeBatch?.targetRound}{' '}
                期样木记录发生了变化，生长量仍按旧差值计算，保存已停用。请重新生成后再保存与交接：
              </Typography.Text>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {drift.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </Space>
          }
        />
      ) : null}

      <Card size="small">
        <Space wrap size={10}>
          <span>
            上期
            <Select
              style={{ width: 120, marginLeft: 6 }}
              value={baseRound}
              onChange={(v) => switchRound('base', v)}
              options={rounds.map((r) => ({ value: r, label: `第 ${r} 期` }))}
            />
          </span>
          <span>
            本期
            <Select
              style={{ width: 120, marginLeft: 6 }}
              value={targetRound}
              onChange={(v) => switchRound('target', v)}
              options={rounds.map((r) => ({ value: r, label: `第 ${r} 期` }))}
            />
          </span>
          <Button type="primary" onClick={generate}>
            生成逐株比对表
          </Button>
          {stale ? (
            <Tooltip title="两期样木已发生变化，请重新生成后再保存">{saveButton}</Tooltip>
          ) : (
            saveButton
          )}
          {stale ? (
            <Tag color="orange" icon={<WarningOutlined />}>
              待重新生成
            </Tag>
          ) : null}
          <Typography.Text type="secondary">
            可选期次：{rounds.length === 0 ? '暂无数据' : rounds.map((r) => `第 ${r} 期`).join('、')}
          </Typography.Text>
        </Space>
      </Card>

      <Row gutter={12}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="比对数" value={diffs.length} suffix="株" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="平均保留木生长率" value={avgRate} precision={2} suffix="%" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="缺测 / 无法匹配" value={missing} suffix="株" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="异常标注" value={abnormal} suffix="条" />
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title={
          <Space wrap size={8}>
            <span>两期逐株差值表</span>
            {stale ? (
              <Tag color="orange" icon={<WarningOutlined />}>
                待重新生成
              </Tag>
            ) : null}
            {activeBatch && !stale ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {drafts ? '本次会话生成，尚未保存' : `已保存 · 生成于 ${new Date(activeBatch.generatedAt).toLocaleString('zh-CN')}`}
              </Typography.Text>
            ) : null}
          </Space>
        }
      >
        <GrowthDiffTable diffs={diffs} emptyText="当前期次对尚无比对结果，请选择上/本期后点击「生成逐株比对表」" />
      </Card>
    </Space>
  );
}
