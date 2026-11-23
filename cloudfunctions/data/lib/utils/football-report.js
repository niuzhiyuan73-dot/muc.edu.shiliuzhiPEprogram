/** 足球赛后报告。比分、名单和统计共用一版审核快照；不依赖现场计分流水。 */
const { normalizeFootballRules } = require('./football-rules');
const FIELDS = Object.freeze({ goals: '进球', assists: '助攻', ownGoals: '乌龙', fouls: '犯规',
  yellowCards: '黄牌', secondYellow: '第二黄罚下', directRed: '直接红牌' });
const COVERAGE = ['none', 'partial', 'full', 'not_applicable'];
const text = value => typeof value === 'string' ? value.trim() : '';
const number = (v, max = 99) => {
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v);
  return Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null;
};
const fail = message => ({ ok: false, message });
function pair(value) {
  if (!value || typeof value !== 'object') return null;
  const A = number(value.A); const B = number(value.B);
  return A === null || B === null ? null : { A, B };
}
function normalizeResult(raw = {}, rules, format) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('比赛结果格式不正确');
  const kind = raw.kind === undefined ? 'completed' : raw.kind;
  if (!['completed', 'forfeit', 'interrupted'].includes(kind)) return fail('请选择有效的比赛结果类型');
  const note = text(raw.note);
  if (note.length > 500) return fail('裁判报告说明不超过 500 字');
  if (kind !== 'completed' && !note) return fail('弃权或中断必须填写裁判报告说明');
  const regulationScore = pair(raw.regulationScore);
  if (!regulationScore) return fail('常规时间比分必填，需为 0–99 的整数；空白不等于 0');
  const halfTimeScore = raw.halfTimeScore == null ? null : pair(raw.halfTimeScore);
  if (raw.halfTimeScore != null && (!halfTimeScore || halfTimeScore.A > regulationScore.A
    || halfTimeScore.B > regulationScore.B)) return fail('半场比分不得超过常规时间比分');
  const result = { kind, note, regulationScore, halfTimeScore, extraTimeScore: null,
    extraTimeCompleted: false, shootoutScore: null, refereeConfirmed: false, forfeit: null,
    awardedScore: null, scoreA: regulationScore.A, scoreB: regulationScore.B, winner: null };
  const hasExtra = raw.extraTimeScore != null || raw.extraTimeCompleted === true;
  const hasShootout = raw.shootoutScore != null;
  if (kind !== 'completed') {
    if (hasExtra || hasShootout) return fail('弃权或中断不填写加时和点球大战');
    if (kind === 'forfeit') {
      if (!['A', 'B'].includes(raw.forfeit)) return fail('请明确弃权方；双方弃权需先由管理员裁定');
      const awarded = pair(raw.awardedScore);
      if (!awarded || (raw.forfeit === 'A' ? awarded.A >= awarded.B : awarded.B >= awarded.A)) {
        return fail('请填写与弃权方一致的判定比分');
      }
      Object.assign(result, { forfeit: raw.forfeit, awardedScore: awarded,
        scoreA: awarded.A, scoreB: awarded.B, winner: raw.forfeit === 'A' ? 'B' : 'A' });
    }
    return { ok: true, value: result };
  }
  const tied = regulationScore.A === regulationScore.B;
  if (format === 'round_robin' || !tied) {
    if (hasExtra || hasShootout) return fail('循环赛或常规已分胜负时不能附加加时、点球大战');
  } else if (rules.knockoutTieBreak === 'extra_time_penalties') {
    const extra = pair(raw.extraTimeScore);
    if (!extra || raw.extraTimeCompleted !== true) return fail('本届规程要求先完成加时，请填加时阶段进球并确认完成');
    result.extraTimeScore = extra; result.extraTimeCompleted = true;
    result.scoreA += extra.A; result.scoreB += extra.B;
  } else if (hasExtra) return fail('本届规程为直接点球，不录入加时');
  if (format !== 'round_robin' && result.scoreA === result.scoreB) {
    const shootout = pair(raw.shootoutScore);
    if (!shootout || shootout.A === shootout.B || raw.refereeConfirmed !== true) {
      return fail('淘汰赛平局须填非平局的点球大战比分，并确认裁判报告');
    }
    result.shootoutScore = shootout; result.refereeConfirmed = true;
    result.winner = shootout.A > shootout.B ? 'A' : 'B';
  } else {
    if (hasShootout) return fail('正式总比分已分胜负，不能附加点球大战');
    result.winner = result.scoreA === result.scoreB ? null : result.scoreA > result.scoreB ? 'A' : 'B';
  }
  return { ok: true, value: result };
}

function normalizeSide(raw = {}, roster = [], rules, hasExtra) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('单场名单格式不正确');
  if (!Array.isArray(raw.players) || raw.players.length > rules.matchRosterMax) return fail('单场名单超过上限或格式不正确');
  const registered = new Map(roster.map(row => [row.userId, row]));
  const seen = new Set(); const players = [];
  for (const input of raw.players) {
    if (!input || !registered.has(input.userId) || seen.has(input.userId)) return fail('单场名单有人未报名或重复');
    seen.add(input.userId);
    const source = registered.get(input.userId);
    const row = { userId: source.userId, name: source.name || source.userId, no: source.no ?? null };
    for (const key of ['starter', 'appeared', 'goalkeeper']) {
      if (typeof input[key] !== 'boolean') return fail('请明确首发、实际出场及守门员标记');
      row[key] = input[key];
    }
    if (row.starter && !row.appeared) return fail('首发球员必须标为实际出场');
    for (const field of Object.keys(FIELDS)) {
      const v = input[field];
      row[field] = v === '' || v === null || v === undefined ? null : number(v,
        field === 'yellowCards' ? 2 : ['secondYellow', 'directRed'].includes(field) ? 1 : 99);
      if (v !== '' && v != null && row[field] === null) return fail(`${FIELDS[field]}需为允许范围内的整数`);
    }
    if (!row.appeared && ['goals', 'assists', 'ownGoals', 'fouls'].some(f => row[f] > 0)) return fail('未出场球员不能记进球、助攻、乌龙或场上犯规');
    if (row.secondYellow === 1 && row.yellowCards !== 2) return fail('第二黄罚下须记录两张黄牌');
    if ((row.secondYellow || 0) + (row.directRed || 0) > 1) return fail('同一球员的罚下不能重复累计');
    // 只录直红（第二黄为空）时也要算 1 次罚下；两项都未录才是未知 null。
    row.dismissals = row.secondYellow === null && row.directRed === null
      ? null
      : (row.secondYellow || 0) + (row.directRed || 0);
    players.push(row);
  }
  if (players.length) {
    const starters = players.filter(p => p.starter);
    if (starters.length < rules.minOnField || starters.length > rules.onFieldMax) return fail('首发须为 7–11 人；少于 11 人需在报告中说明');
    if (starters.filter(p => p.goalkeeper).length !== 1) return fail('首发须明确一名守门员');
  }
  const coverage = {};
  for (const field of Object.keys(FIELDS)) {
    const status = (raw.coverage || {})[field] ?? 'none';
    if (!COVERAGE.includes(status)) return fail('统计完整性标记无效');
    const relevant = ['yellowCards', 'secondYellow', 'directRed'].includes(field) ? players : players.filter(p => p.appeared);
    if (['none', 'not_applicable'].includes(status) && players.some(p => p[field] !== null)) return fail(`${FIELDS[field]}标记未记录或不统计时不能填数字`);
    if (status === 'full' && (!relevant.length || relevant.some(p => p[field] === null))) return fail(`${FIELDS[field]}标记完整时需填齐相关球员，已统计为零请填 0`);
    coverage[field] = status;
  }
  const sub = raw.substitutions || { status: 'none' };
  if (!['none', 'partial', 'full'].includes(sub.status)) return fail('换人报告完整性无效');
  const substitutions = { status: sub.status, incomingIds: [] };
  if (sub.status !== 'none') {
    for (const field of ['regulationCount', 'regulationOpportunities', 'halfTimeCount', 'extraTimeCount', 'extraTimeOpportunities', 'extraBreakCount']) {
      substitutions[field] = number(sub[field]);
      if (substitutions[field] === null) return fail('换人人数和机会须填非负整数');
    }
    const s = substitutions; const r = rules.substitutions;
    if (!hasExtra && (s.extraTimeCount || s.extraTimeOpportunities || s.extraBreakCount)) return fail('未打加时不能记录加时换人');
    if (s.halfTimeCount > s.regulationCount || s.extraBreakCount > s.extraTimeCount) return fail('中场/加时间歇换人人次不能超过所属阶段总人次');
    const capacity = players.filter(p => !p.starter).length;
    const limit = r.limit === 'all_named' ? (r.returnAllowed ? Infinity : capacity) : r.limit;
    if (s.regulationCount > limit || s.regulationCount + s.extraTimeCount > limit + (hasExtra ? r.extraTimeAdditionalPlayers : 0)) return fail('换人总额度超过本届规程');
    const opportunities = s.regulationOpportunities + (r.halfTimeCountsAsOpportunity && s.halfTimeCount ? 1 : 0);
    if (r.opportunities !== 'unlimited' && (opportunities > r.opportunities
      || opportunities + s.extraTimeOpportunities > r.opportunities + (hasExtra ? r.extraTimeAdditionalOpportunities : 0))) return fail('比赛中换人机会超过本届规程');
    if (s.regulationOpportunities > s.regulationCount - s.halfTimeCount
      || s.extraTimeOpportunities > s.extraTimeCount - s.extraBreakCount) return fail('换人机会不能超过比赛中替换人次');
    if ((s.regulationCount > s.halfTimeCount && !s.regulationOpportunities)
      || (s.extraTimeCount > s.extraBreakCount && !s.extraTimeOpportunities)) return fail('比赛中有换人时需记录换人机会');
    const ids = Array.isArray(sub.incomingIds) ? sub.incomingIds : [];
    if (ids.some(id => !seen.has(id)) || new Set(ids).size !== ids.length) return fail('换入队员须属于单场名单且不重复');
    if (!r.returnAllowed && ids.some(id => players.find(p => p.userId === id).starter)) return fail('禁止复入时首发不能再次换入');
    if (ids.some(id => !players.find(p => p.userId === id).appeared)) return fail('换入球员须标为实际出场');
    if (!r.returnAllowed && s.regulationCount + s.extraTimeCount > capacity) return fail('换人总数超过列名替补人数');
    if (sub.status === 'full') {
      const entered = players.filter(p => p.appeared && !p.starter).map(p => p.userId);
      if (entered.some(id => !ids.includes(id)) || ids.length > s.regulationCount + s.extraTimeCount
        || (!r.returnAllowed && ids.length !== s.regulationCount + s.extraTimeCount)) return fail('完整换人摘要须与实际换入球员及替换人次一致');
    }
    substitutions.incomingIds = ids.slice();
  }
  return { ok: true, value: { players, coverage, substitutions } };
}

function normalizeFootballReport(raw, { rules: inputRules, format, rosters }) {
  const rules = normalizeFootballRules(inputRules);
  if (!rules || !raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('足球规则或赛后报告无效');
  const result = normalizeResult(raw.result, rules, format);
  if (!result.ok) return result;
  const sides = {};
  for (const key of ['A', 'B']) {
    const side = normalizeSide((raw.sides || {})[key] || { players: [] }, rosters[key] || [], rules, result.value.extraTimeCompleted);
    if (!side.ok) return fail(`${key} 队：${side.message}`);
    sides[key] = side.value;
    const starters = side.value.players.filter(p => p.starter).length;
    if (starters && starters < 11 && !result.value.note) return fail('少于 11 人首发须填写裁判报告说明');
  }
  const goalEvents = [];
  if (raw.goalEvents !== undefined && (!Array.isArray(raw.goalEvents) || raw.goalEvents.length > 198)) return fail('进球明细格式无效');
  for (const item of raw.goalEvents || []) {
    if (!item || !['A', 'B'].includes(item.side) || !['normal', 'penalty', 'free_kick', 'own_goal'].includes(item.type)) return fail('进球明细类型无效');
    const scorer = sides[item.side].players.find(p => p.userId === item.scorerId && p.appeared);
    if (!scorer) return fail('进球明细的球员须在实际出场名单中');
    const assistId = item.assistId || null;
    if (assistId && (item.type !== 'normal' || assistId === item.scorerId
      || !sides[item.side].players.some(p => p.userId === assistId && p.appeared))) return fail('一次普通进球最多一名本队助攻人，不能自助攻；乌龙、直接任意球及点球不附助攻');
    const minute = item.minute === '' || item.minute == null ? null : number(item.minute, 200);
    if (item.minute !== '' && item.minute != null && minute === null) return fail('进球分钟需为 0–200 的整数或留空');
    goalEvents.push({ side: item.side, type: item.type, scorerId: item.scorerId, assistId, minute });
  }
  for (const key of ['A', 'B']) {
    for (const row of sides[key].players) {
      for (const field of ['goals', 'ownGoals', 'assists']) {
        const count = goalEvents.filter(g => g.side === key && (field === 'assists' ? g.assistId === row.userId
          : g.scorerId === row.userId && (field === 'ownGoals' ? g.type === 'own_goal' : g.type !== 'own_goal'))).length;
        if ((count && (row[field] === null || count > row[field])) || (field === 'assists' && (row.assists || 0) !== count)) return fail('进球明细与个人统计不一致；每次助攻须关联一条进球明细');
      }
    }
  }
  const warnings = []; const unassigned = {};
  if (result.value.kind !== 'interrupted') {
    for (const key of ['A', 'B']) {
      const opposite = key === 'A' ? 'B' : 'A';
      const known = sides[key].players.reduce((s, p) => s + (p.goals || 0), 0)
        + sides[opposite].players.reduce((s, p) => s + (p.ownGoals || 0), 0);
      const official = result.value.kind === 'forfeit' ? result.value.regulationScore[key]
        : result.value[key === 'A' ? 'scoreA' : 'scoreB'];
      if (known > official) return fail(`${key} 队个人进球加对方乌龙超过正式比分`);
      unassigned[key] = official - known;
      if (sides[key].coverage.goals === 'full' && sides[opposite].coverage.ownGoals === 'full' && known !== official) return fail('完整进球统计必须与正式比分一致');
      if (known < official) warnings.push(`${key} 队还有 ${official - known} 球未归属`);
    }
  }
  if (['A', 'B'].some(key => sides[key].substitutions.status !== 'full')) warnings.push('换人摘要未完整记录，仅依据已填赛后报告校验');
  return { ok: true, value: { result: result.value, sides, goalEvents, unassigned, warnings }, warnings };
}

function scoreText(result) {
  if (!result) return '—';
  if (result.kind === 'interrupted') return `${result.scoreA} : ${result.scoreB}（中断，待裁定）`;
  const shootout = result.shootoutScore;
  return `${result.scoreA} : ${result.scoreB}${shootout ? `（点球 ${shootout.A} : ${shootout.B}）` : ''}${result.kind === 'forfeit' ? '（判定比分）' : ''}`;
}
function matchMinutes(rules, format) {
  return rules.halfMinutes * 2 + rules.halfTimeMinutes
    + (format !== 'round_robin' && rules.extraTime ? rules.extraTime.halfMinutes * 2 : 0) + 20;
}
module.exports = { FIELDS, COVERAGE, normalizeFootballReport, normalizeResult, normalizeSide, scoreText, matchMinutes };
