import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Select, Space, Statistic, Tag, Tooltip, Typography } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import GrowthDiffTable from '../components/common/GrowthDiffTable';
import RoundTag from '../components/common/RoundTag';
import { loadRecheckDiffs, saveRecheckDiffs } from '../utils/db';
import { newId } from '../utils/id';
import { roundTreesFingerprint } from '../utils/forestCalc';
import { growthRate, isDiffAbnormal, type RecheckDiff } from '../types/recheck';
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
  const [diffs, setDiffs] = useState<RecheckDiff[]>([]);
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
    void loadRecheckDiffs(id).then((rows) => {
      setDiffs(rows.filter((r) => r.baseRound === baseRound && r.targetRound === targetRound));
    });
  }, [id, baseRound, targetRound]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

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
    // 记录生成时两期样木状态指纹，后续任一期样木变化都能检出结果失效
    const baseFingerprint = roundTreesFingerprint(trees, id, baseRound);
    const targetFingerprint = roundTreesFingerprint(trees, id, targetRound);

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
        baseFingerprint,
        targetFingerprint,
        generatedAt: Date.now(),
      };
    });

    setDiffs(next);
    setError('');
    setToast(`已生成第 ${baseRound} 期 → 第 ${targetRound} 期的逐株比对表，共 ${next.length} 条`);
  };

  // 当前两期样木的实时指纹，与比对生成时记录的指纹比对即可检出失效
  const currentBaseFp = useMemo(
    () => roundTreesFingerprint(trees, id, baseRound),
    [trees, id, baseRound],
  );
  const currentTargetFp = useMemo(
    () => roundTreesFingerprint(trees, id, targetRound),
    [trees, id, targetRound],
  );

  const stale = useMemo(() => {
    if (diffs.length === 0) return { outdated: false, changedRounds: [] as number[] };
    const changed = new Set<number>();
    diffs.forEach((d) => {
      if (d.baseFingerprint !== currentBaseFp) changed.add(d.baseRound);
      if (d.targetFingerprint !== currentTargetFp) changed.add(d.targetRound);
    });
    return { outdated: changed.size > 0, changedRounds: Array.from(changed).sort((a, b) => a - b) };
  }, [diffs, currentBaseFp, currentTargetFp]);

  const save = async () => {
    if (diffs.length === 0) {
      setError('请先生成比对表');
      return;
    }
    if (stale.outdated) {
      setError('相关期次样木记录已变更，请重新生成比对表后再保存');
      return;
    }
    await saveRecheckDiffs(diffs);
    setToast(`逐株比对表已写入本地档案库（${diffs.length} 条）`);
  };

  const abnormal = diffs.filter(isDiffAbnormal).length;
  const missing = diffs.filter((d) => !d.targetDbhCm).length;
  const avgRate =
    diffs.filter((d) => d.targetDbhCm).length === 0
      ? 0
      : r2(
          diffs.filter((d) => d.targetDbhCm).reduce((s, d) => s + growthRate(d), 0) /
            diffs.filter((d) => d.targetDbhCm).length,
        );

  if (!plot) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该样地" />
        <Link to="/plots">返回样地台账</Link>
      </Space>
    );
  }

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
      {stale.outdated ? (
        <Alert
          type="warning"
          showIcon
          message={`第 ${stale.changedRounds.join('、')} 期样木记录已变更，当前比对结果已失效，待重新生成`}
          description="重新生成逐株比对表后即可恢复保存；无关期次的改动不会影响本比对。"
        />
      ) : null}

      <Card size="small">
        <Space wrap size={10}>
          <span>
            上期
            <Select
              style={{ width: 120, marginLeft: 6 }}
              value={baseRound}
              onChange={setBaseRound}
              options={rounds.map((r) => ({ value: r, label: `第 ${r} 期` }))}
            />
          </span>
          <span>
            本期
            <Select
              style={{ width: 120, marginLeft: 6 }}
              value={targetRound}
              onChange={setTargetRound}
              options={rounds.map((r) => ({ value: r, label: `第 ${r} 期` }))}
            />
          </span>
          <Button type="primary" onClick={generate}>
            生成逐株比对表
          </Button>
          <Tooltip title={stale.outdated ? '样木记录已变更，需重新生成后才能保存' : undefined}>
            <Button icon={<SaveOutlined />} disabled={stale.outdated} onClick={save}>
              保存比对结果
            </Button>
          </Tooltip>
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
          <Space size={8}>
            两期逐株差值表
            {stale.outdated ? <Tag color="warning">待重新生成</Tag> : null}
          </Space>
        }
      >
        <GrowthDiffTable diffs={diffs} />
      </Card>
    </Space>
  );
}
