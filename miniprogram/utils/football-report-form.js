const { FIELDS } = require('../shared/utils/football-report');
const coverageKeys = ['none', 'partial', 'full', 'not_applicable'];
const coverageLabels = ['未记录', '部分记录', '已完整记录', '本场不统计'];
const subKeys = ['regulationCount', 'regulationOpportunities', 'halfTimeCount', 'extraTimeCount', 'extraTimeOpportunities', 'extraBreakCount'];
const subLabels = ['常规替换总人次', '常规比赛中换人机会', '常规中场替换人次', '加时替换总人次', '加时比赛中换人机会', '加时前及中场替换人次'];
const str = v => v == null ? '' : String(v);
function createReportForm(data) {
  const report = data.report || {}; const result = report.result || {};
  const kindIndex = ['completed', 'forfeit', 'interrupted'].indexOf(result.kind || 'completed');
  return { kindIndex, regulationA: str(result.regulationScore?.A), regulationB: str(result.regulationScore?.B),
    halfA: str(result.halfTimeScore?.A), halfB: str(result.halfTimeScore?.B),
    extraA: str(result.extraTimeScore?.A), extraB: str(result.extraTimeScore?.B),
    extraTimeCompleted: result.extraTimeCompleted === true,
    shootoutA: str(result.shootoutScore?.A), shootoutB: str(result.shootoutScore?.B),
    refereeConfirmed: result.refereeConfirmed === true, forfeitIndex: result.forfeit === 'B' ? 1 : 0,
    awardedA: str(result.awardedScore?.A ?? 0), awardedB: str(result.awardedScore?.B ?? 3),
    note: result.note || '', reason: data.correctionReason || '',
    sides: ['A', 'B'].map(key => {
      const saved = report.sides?.[key] || data.lineups?.[key] || {};
      const sub = saved.substitutions || { status: 'none' };
      return { key, name: data[key === 'A' ? 'teamAName' : 'teamBName'],
        recordedCount: (saved.players || []).length,
        coverage: Object.entries(FIELDS).map(([field, label]) => ({ field, label, index: Math.max(0, coverageKeys.indexOf(saved.coverage?.[field] || 'none')) })),
        players: (data.rosters?.[key] || []).map(p => {
          const hit = (saved.players || []).find(r => r.userId === p.userId);
          return { userId: p.userId, name: p.name || p.userId, no: p.no ?? '—', selected: Boolean(hit),
            incoming: (sub.incomingIds || []).includes(p.userId),
            starter: hit?.starter === true, appeared: hit?.appeared === true, goalkeeper: hit?.goalkeeper === true,
            cells: Object.entries(FIELDS).map(([field, label]) => ({ field, label, value: str(hit?.[field]) })) };
        }),
        subIndex: ['none', 'partial', 'full'].indexOf(sub.status),
        subCells: subKeys.map((field, i) => ({ field, label: subLabels[i], value: str(sub[field]) })),
        incomingIds: sub.incomingIds || [],
      };
    }), goalEvents: (report.goalEvents || []).map(g => ({ ...g, minute: str(g.minute) })) };
}
function reportPayload(form) {
  const optionalPair = (a, b) => a === '' && b === '' ? null : { A: a, B: b };
  const result = { kind: ['completed', 'forfeit', 'interrupted'][form.kindIndex],
    regulationScore: { A: form.regulationA, B: form.regulationB }, halfTimeScore: optionalPair(form.halfA, form.halfB),
    extraTimeScore: optionalPair(form.extraA, form.extraB), extraTimeCompleted: form.extraTimeCompleted,
    shootoutScore: optionalPair(form.shootoutA, form.shootoutB), refereeConfirmed: form.refereeConfirmed,
    forfeit: form.forfeitIndex ? 'B' : 'A', awardedScore: { A: form.awardedA, B: form.awardedB }, note: form.note };
  const sides = {};
  form.sides.forEach(side => {
    sides[side.key] = { players: side.players.filter(p => p.selected).map(p => ({ userId: p.userId,
      starter: p.starter, appeared: p.appeared, goalkeeper: p.goalkeeper,
      ...Object.fromEntries(p.cells.map(c => [c.field, c.value])) })),
    coverage: Object.fromEntries(side.coverage.map(c => [c.field, coverageKeys[c.index]])),
    substitutions: { status: ['none', 'partial', 'full'][side.subIndex], incomingIds: side.incomingIds,
      ...Object.fromEntries(side.subCells.map(c => [c.field, c.value])) } };
  });
  return { result, sides, goalEvents: form.goalEvents };
}
module.exports = { createReportForm, reportPayload, coverageLabels };
