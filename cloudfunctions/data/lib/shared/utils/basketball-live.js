/** 篮球单人计分与统计。球队总分独立；个人统计允许补录、不强制对齐。 */
const BASKETBALL_STAT_LIMITS = { points: 199, rebounds: 60, assists: 60,
  steals: 40, blocks: 40, turnovers: 40, fouls: 10 };

function createBasketballLive(rules = {}) {
  return { revision: 0, period: 1, regulationPeriods: Number(rules.periods) || 4,
    scoreA: 0, scoreB: 0, periods: [{ scoreA: 0, scoreB: 0 }], history: [], operationIds: [],
    playerRows: [], statMode: 'basic' };
}

function periodLabel(period, regulationPeriods) {
  return period > regulationPeriods ? `加时 ${period - regulationPeriods}` : `第 ${period} 节`;
}

/** 纯变换，同一规则用于服务端与本地即时预览。撤销可回退加分或换节。 */
function applyBasketballOperation(state, operation) {
  const next = { ...state, periods: state.periods.map(row => ({ ...row })),
    ...(state.onCourt ? { onCourt: { A: [...state.onCourt.A], B: [...state.onCourt.B] } } : {}),
    playerRows: (state.playerRows || []).map(row => ({ ...row })),
    history: [...(state.history || [])], operationIds: [...(state.operationIds || [])] };
  const { type, side, points } = operation;
  if (type === 'undo') {
    const previous = next.history.pop();
    if (!previous) throw new Error('没有可撤销的操作');
    next.period = previous.period;
    next.scoreA = previous.scoreA;
    next.scoreB = previous.scoreB;
    next.periods = previous.periods.map(row => ({ ...row }));
    if (previous.courtChange) next.onCourt[previous.courtChange.side] = [...previous.courtChange.players];
    if (previous.playerChange) {
      const change = previous.playerChange;
      const index = next.playerRows.findIndex(row => row.side === change.side
        && row.userId === change.userId && row.period === change.period);
      if (change.existed) {
        if (index >= 0) next.playerRows[index][change.field] = change.value;
      } else if (index >= 0) next.playerRows.splice(index, 1);
    }
  } else {
    const previous = { period: state.period, scoreA: state.scoreA, scoreB: state.scoreB,
      periods: state.periods.map(row => ({ ...row })) };
    const changePlayer = (field, delta) => {
      if (!['A', 'B'].includes(side) || typeof operation.userId !== 'string' || !operation.userId) {
        throw new Error('请先选择本队球员');
      }
      if (state.onCourt && !(state.onCourt[side] || []).includes(operation.userId)) {
        throw new Error('该球员不在场上，请先通过换人上场');
      }
      const period = state.statMode === 'detailed' ? state.period : 0;
      let row = next.playerRows.find(item => item.side === side
        && item.userId === operation.userId && item.period === period);
      previous.playerChange = { side, userId: operation.userId, period, field,
        existed: Boolean(row), value: row && Number.isInteger(row[field]) ? row[field] : null };
      if (!row) {
        row = { side, userId: operation.userId, period };
        for (const key of Object.keys(BASKETBALL_STAT_LIMITS)) row[key] = null;
        next.playerRows.push(row);
      }
      const value = (Number.isInteger(row[field]) ? row[field] : 0) + delta;
      if (value < 0) throw new Error('本节该项统计不能小于 0');
      if (value > BASKETBALL_STAT_LIMITS[field]) throw new Error('该项统计已达上限');
      row[field] = value;
    };
    if (type === 'score') {
      if (!['A', 'B'].includes(side) || ![1, 2, 3].includes(points)) throw new Error('加分只支持 1、2、3 分');
      if (operation.playerOnly && !operation.userId) throw new Error('只补个人得分时必须选球员');
      if (!operation.playerOnly) {
        if (next[`score${side}`] + points > 299) throw new Error('单队总分不能超过 299');
        next[`score${side}`] += points;
        next.periods[next.period - 1][`score${side}`] += points;
      }
      if (operation.userId) changePlayer('points', points);
    } else if (type === 'stat') {
      if (!Object.prototype.hasOwnProperty.call(BASKETBALL_STAT_LIMITS, operation.field)
        || ![1, -1].includes(operation.delta)) throw new Error('统计操作不合法');
      changePlayer(operation.field, operation.delta);
    } else if (type === 'substitute') {
      const players = (next.onCourt || {})[side];
      if (!players || !players.includes(operation.outId) || players.includes(operation.inId)
        || typeof operation.inId !== 'string' || !operation.inId) throw new Error('请选择场上球员与替补各一人');
      previous.courtChange = { side, players: [...players] };
      players[players.indexOf(operation.outId)] = operation.inId;
    } else if (type === 'nextPeriod') {
      if (next.period >= next.regulationPeriods && next.scoreA !== next.scoreB) {
        throw new Error('已分出胜负，可以结束比赛；平分时才进入加时');
      }
      if (next.period >= 24) throw new Error('节次数已达上限');
      next.period += 1;
      next.periods.push({ scoreA: 0, scoreB: 0 });
    } else throw new Error('不支持的计分操作');
    next.history.push(previous);
  }
  next.revision += 1;
  return next;
}

/** 客户端不需要整场操作流水。 */
function basketballLiveView(state, includePlayers = true) {
  if (!state) return null;
  return { revision: state.revision, period: state.period, regulationPeriods: state.regulationPeriods,
    periodLabel: periodLabel(state.period, state.regulationPeriods),
    scoreA: state.scoreA, scoreB: state.scoreB,
    periods: state.periods.map((row, index) => ({ ...row,
      label: periodLabel(index + 1, state.regulationPeriods) })),
    canUndo: (state.history || []).length > 0, submitted: Boolean(state.submittedAt),
    ...(includePlayers ? { statMode: state.statMode || 'basic',
      onCourt: { A: [...((state.onCourt || {}).A || [])], B: [...((state.onCourt || {}).B || [])] },
      playerRows: (state.playerRows || []).map(row => ({ ...row })) } : {}) };
}

module.exports = { createBasketballLive, applyBasketballOperation, basketballLiveView, BASKETBALL_STAT_LIMITS };
