/**
 * 实时比分状态机
 * ============================================================
 * 一场比赛从「逐球累计」到「整场定稿」的全部纯逻辑都住在这里：
 * 判一球、撤一球、重算进度、转正式比分。不碰 wx、不碰数据源，
 * 因此三端共用同一份实现（经 lib/ 镜像被云端复用）。
 *
 * 【逐球流水是唯一事实】
 * 与「比分是唯一事实来源」同一纪律：整场的当前分、局数、第几局，
 * 全部由 rallies 现算出来，绝不单独维护一份可漂移的计数。写库时
 * 也把这些派生字段一起存下来，只是为了轮询时读得轻——真出了分歧，
 * rallies 说了算（derive 一遍即回到一致）。
 *
 * 【折叠之后，这份「事实」是两段】（2026-10-23 第三轮 X-13）
 * 一场长盘可以打 200~400 球，而每次判球都要整条文档重写、整段流水重放，
 * 成本随球数线性增长——越到决胜局越卡。现在只保留**最近 RALLY_KEEP 球**
 * 作为可撤销窗口，更早的按「局边界」折叠进 `folded`：
 *   · `folded.base`：窗口起点处的派生状态（局数 / 盘数 / 第几局）。重算从这里
 *     续算，它是当时同一套 replay 算出来的，不是手写计数；
 *   · `folded.games` / `sets` / `tiebreaks`：已折叠的局与盘摘要，定稿拼正式比分时要用。
 * 折叠只在局边界发生，所以窗口起点恒为「新一局开局」——不会留下半局残影。
 * 可撤销范围因此变成「最近一局 + 最近 RALLY_KEEP 球」，折不到开场。
 *
 * 【一球怎么算一局】
 * 沿用 utils/match-format.js 的口径：够分且领先 2 分才算赢下一局，
 * 不封顶。11 分制可以是 13:11，也可以一直打到 17:15。局数过半
 * （gamesToWin）即整场结束。
 *
 * 【为什么每球不 bumpSeason】
 * 实时态是录分过程的中间态，不是回放的输入。只有定稿（finishLiveScore）
 * 转成正式比分走 submitMatch 时才让赛季版本号 +1，整季才重放一次。
 * ============================================================
 */

const { MATCH_COMPETITION } = require('../utils/constants.js');
const {
  gamesToWin,
  scoringOf,
  normalizeTennisFormat,
  formatOfRecord,
  tennisGameWon,
  tennisSetWon,
  SCORING,
  DEFAULT_FORMAT,
  DEFAULT_TENNIS_FORMAT,
} = require('../utils/match-format.js');

/** 实时态状态 */
const LIVE_STATUS = {
  LIVE: 'live',
  FINISHED: 'finished',
};

/** 判球方向 */
const SIDE = {
  A: 'A',
  B: 'B',
};

/**
 * 逐球流水的折叠水位（2026-10-23 第三轮 X-13）。
 *
 * 【为什么是「保留 20 / 满 40 才折叠」】
 * 20 球够覆盖一局（11 分制最长的一局约 20 球，网球一局通常 4~10 球），
 * 也就是说「刚打完的那一局」整局都还在窗口里，撤销制胜球这类最常见的临场
 * 更正不受影响。40 的缓冲让折叠不必每一球都尝试：窗口涨到 41 才折一次，
 * 折到约 20，于是折叠次数与局数同阶，而不是与球数同阶。
 */
const RALLY_KEEP = 20;
const RALLY_FOLD_AT = 40;

/**
 * 实时态的主键。一场比赛恒一条，重启不堆记录。
 * @param {string} matchId
 * @returns {string}
 */
function liveKey(matchId) {
  return `ls_${matchId}`;
}

/**
 * 归一赛制。比赛记录上的赛制理应是合法的，但历史数据 / 脏数据兜一层，
 * 免得一局都算不出来。
 *
 * 网球记录没有 gamePoints（一局恒定 4 分），硬套 11 分制会把 6:4 读成
 * 「没人打到 11 分」，一场都算不出来——所以必须按 scoring 分开兜。
 *
 * @param {Object} match
 * @returns {Object} point：{gamePoints,bestOf}；tennis：{scoring:'tennis',bestOf,setGames,…}
 */
function formatOf(match) {
  // 计分台必须有确定的赛制才能推进（不像展示层可以把「没记赛制」显示成空）。
  // formatOfRecord 对老数据返回 null，这里按个人赛默认赛制 11 分制 / 三局两胜兜底。
  if (match && match.scoring === SCORING.TENNIS) {
    return formatOfRecord(match) || { ...DEFAULT_TENNIS_FORMAT };
  }
  return formatOfRecord(match) || { ...DEFAULT_FORMAT };
}

/**
 * 由一场比赛生成初始实时态。
 *
 * @param {Object} match 比赛记录（含 teamA / teamB / 赛制；学院赛小场另带学院等）
 * @param {Object} [ctx]
 * @param {string} [ctx.actorId] 开台人
 * @param {Date} [ctx.now]
 * @returns {Object} 初始实时态
 */
function createLive(match, ctx = {}) {
  const { actorId = '', now = new Date() } = ctx;
  const format = formatOf(match);
  const isCollege = Boolean(match) && match.competition === MATCH_COMPETITION.COLLEGE;

  return {
    _id: liveKey(match._id),
    matchId: match._id,
    // personal | college —— 查看端据此决定显示学院名还是队员姓名
    competition: isCollege ? 'college' : 'personal',
    eventId: match.eventId || '',
    collegeEventId: match.collegeEventId || '',
    tieId: match.tieId || '',
    legNo: match.legNo === undefined || match.legNo === null ? null : match.legNo,
    discipline: match.discipline || '',
    collegeA: match.collegeA || '',
    collegeB: match.collegeB || '',
    // 查看端要显示姓名，这里只存编号，由调用方解析
    teamA: Array.isArray(match.teamA) ? [...match.teamA] : [],
    teamB: Array.isArray(match.teamB) ? [...match.teamB] : [],
    // 赛制整块落在实时态上：重算只看这一份，不必再回查比赛记录
    ...(scoringOf(format) === 'tennis'
      ? {
          scoring: 'tennis',
          bestOf: format.bestOf,
          setGames: format.setGames,
          tiebreakAt: format.tiebreakAt,
          tiebreakPoints: format.tiebreakPoints,
          noAd: format.noAd === true,
        }
      : { gamePoints: format.gamePoints, bestOf: format.bestOf }),
    status: LIVE_STATUS.LIVE,
    gameIndex: 0,
    // 网球的盘序号与盘数；其余项目恒 0，展示端不看它们
    setIndex: 0,
    setsA: 0,
    setsB: 0,
    inTiebreak: false,
    pointsA: 0,
    pointsB: 0,
    gamesA: 0,
    gamesB: 0,
    // 逐球流水：既是撤销依据，也是审计。id 用于幂等去重（服务层要求必填），
    // 只在窗口内有效——更早的已折叠进 folded（见 X-13）。
    rallies: [],
    updatedBy: actorId,
    updatedAt: now,
    startedAt: now,
  };
}

/**
 * 一局是否已经分出胜负（point 体系）：够分且领先 2 分。
 * @param {number} points
 * @param {number} other
 * @param {number} gamePoints
 * @returns {boolean}
 */
function gameWon(points, other, gamePoints) {
  return points >= gamePoints && points - other >= 2;
}

/**
 * point 体系（匹克球 / 乒乓 / 羽毛球）的重算：分 → 局 → 场，两级。
 *
 * 【为什么每次判球都整条重算】
 * 重算的是**窗口**（折叠后最多 RALLY_FOLD_AT 球，见下方 X-13 的说明），不是整场，
 * 所以成本与总球数无关；而撤销一球之后，状态必须与「从没判过那一球」完全一致——
 * 重算天然满足，增量更新迟早会留下残影。
 *
 * 【为什么「打完最后一局」与「打完中间某一局」要分开处理】
 * 中间某一局打完，确实该清零并进下一局。最后一局打完却不同：没有「下一局」
 * 可进，那一局就是终局。若不分青红皂白地清零 +1，定稿前后的查看端会看到
 * 「已结束 · 第 4 局 · 0 : 0」——比分归零、局数凭空多一局，真正的终局比分
 * 反而被抹掉。所以整场结束时就停在末局：分数不清、局数不增。
 *
 * @param {Array<Object>} rallies 逐球流水 [{ g, side, id? }]
 * @param {Object} format { gamePoints, bestOf }
 * @param {Object|null} [base] 折叠水位处的派生状态（局边界：局数已知、本局 0:0）
 * @returns {{gameIndex:number, pointsA:number, pointsB:number, gamesA:number, gamesB:number, games:Array<{a:number,b:number}>, finished:boolean}}
 */
function replayPointRallies(rallies, format, base = null) {
  const list = Array.isArray(rallies) ? rallies : [];
  const gamePoints = format.gamePoints;
  const need = gamesToWin(format.bestOf);

  // 折叠水位只落在「新一局开局」，所以小分恒从 0:0 起算；局数与第几局接着
  // 摘要续算——这样「局数过半即整场结束」的判定仍然看得到折叠前已赢的局。
  let pointsA = 0;
  let pointsB = 0;
  let gamesA = base ? Number(base.gamesA) || 0 : 0;
  let gamesB = base ? Number(base.gamesB) || 0 : 0;
  let gameIndex = base ? Number(base.gameIndex) || 0 : 0;
  let finished = false;
  const games = [];

  for (const rally of list) {
    const side = rally && rally.side;
    if (side !== SIDE.A && side !== SIDE.B) continue;
    if (side === SIDE.A) pointsA += 1;
    else pointsB += 1;

    const aWon = gameWon(pointsA, pointsB, gamePoints);
    const bWon = gameWon(pointsB, pointsA, gamePoints);
    if (!aWon && !bWon) continue;

    if (aWon) gamesA += 1;
    else gamesB += 1;
    games.push({ a: pointsA, b: pointsB });

    // 整场打完就收手：停在末局（分数不清零、局数不再 +1，见上面说明），
    // 后面的球一律不再计——脏数据 / 连点会往流水里塞进「赢完还在加分」的球。
    if (gamesA >= need || gamesB >= need) {
      finished = true;
      break;
    }

    // 记一局、进下一局
    pointsA = 0;
    pointsB = 0;
    gameIndex += 1;
  }

  return { gameIndex, pointsA, pointsB, gamesA, gamesB, games, finished };
}

/**
 * 网球的重算：分 → 局 → 盘 → 场，三级。
 *
 * 与 point 体系的两处关键差异：
 *   1. 一局恒定 4 分（40:40 需连得 2；noAd 时下一分直接定胜负）；
 *   2. 一盘到 6 局且领先 2 局，6:6 进抢七（短盘 4:4），抢七胜者以 7:6 拿下该盘。
 * 抢七那一路必须单独判：它一结束就直接是一盘的终点，不会再回到普通的「局」。
 *
 * 返回的 gamesA / gamesB 是**当前盘**的局数，setsA / setsB 才是赢下的盘数。
 * 展示端要的是「盘分 + 本盘局分 + 本局分」，三者分别对应 sets / games / points。
 *
 * @param {Array<Object>} rallies
 * @param {Object} format 网球赛制
 * @param {Object|null} [base] 折叠水位处的派生状态（局边界：盘数 / 本盘局数 / 第几盘）
 * @returns {{gameIndex:number, setIndex:number, pointsA:number, pointsB:number,
 *            gamesA:number, gamesB:number, setsA:number, setsB:number,
 *            games:Array<Object>, sets:Array<Object>, tiebreaks:Array<Object>,
 *            inTiebreak:boolean, finished:boolean}}
 */
function replayTennisRallies(rallies, format, base = null) {
  const list = Array.isArray(rallies) ? rallies : [];
  const cfg = normalizeTennisFormat(format) || { ...DEFAULT_TENNIS_FORMAT };
  const need = gamesToWin(cfg.bestOf);

  // 与 point 体系同理：小分从 0:0 起算，盘数 / 本盘局数 / 盘序号接着摘要走。
  // `inTiebreak` 不继承——折叠只发生在局边界，抢七是「局」的一种，不可能是十字路口。
  let pointsA = 0;
  let pointsB = 0;
  let gamesA = base ? Number(base.gamesA) || 0 : 0;
  let gamesB = base ? Number(base.gamesB) || 0 : 0;
  let setsA = base ? Number(base.setsA) || 0 : 0;
  let setsB = base ? Number(base.setsB) || 0 : 0;
  let gameIndex = base ? Number(base.gameIndex) || 0 : 0;
  let setIndex = base ? Number(base.setIndex) || 0 : 0;
  let inTiebreak = false;
  let finished = false;
  const games = [];
  const sets = [];
  const tiebreaks = [];

  /** 收下一盘：记盘比分、盘数 +1，并判断整场是否结束 */
  const closeSet = () => {
    sets.push({ a: gamesA, b: gamesB });
    if (gamesA > gamesB) setsA += 1;
    else setsB += 1;
    return setsA >= need || setsB >= need;
  };

  for (const rally of list) {
    const side = rally && rally.side;
    if (side !== SIDE.A && side !== SIDE.B) continue;
    if (side === SIDE.A) pointsA += 1;
    else pointsB += 1;

    // —— 抢七：分先到 7 且领先 2，胜者直接拿下这一局与这一盘 ——
    if (inTiebreak) {
      const aWon = pointsA >= cfg.tiebreakPoints && pointsA - pointsB >= 2;
      const bWon = pointsB >= cfg.tiebreakPoints && pointsB - pointsA >= 2;
      if (!aWon && !bWon) continue;

      if (aWon) gamesA += 1;
      else gamesB += 1;
      tiebreaks.push({ setIndex, a: pointsA, b: pointsB });
      games.push({ a: pointsA, b: pointsB, tiebreak: true });
      inTiebreak = false;
      pointsA = 0;
      pointsB = 0;

      finished = closeSet();
      if (finished) break;
      gamesA = 0;
      gamesB = 0;
      gameIndex = 0;
      setIndex += 1;
      continue;
    }

    const aWon = tennisGameWon(pointsA, pointsB, cfg.noAd);
    const bWon = tennisGameWon(pointsB, pointsA, cfg.noAd);
    if (!aWon && !bWon) continue;

    games.push({ a: pointsA, b: pointsB });
    if (aWon) gamesA += 1;
    else gamesB += 1;
    pointsA = 0;
    pointsB = 0;

    // 6:6（短盘 4:4）进抢七：这一局先不计入盘比分，抢七打完直接定盘
    if (gamesA === cfg.setGames && gamesB === cfg.setGames) {
      inTiebreak = true;
      continue;
    }

    const setDone = tennisSetWon(gamesA, gamesB, cfg.setGames) || tennisSetWon(gamesB, gamesA, cfg.setGames);
    if (!setDone) {
      gameIndex += 1;
      continue;
    }

    finished = closeSet();
    if (finished) break;
    gamesA = 0;
    gamesB = 0;
    gameIndex = 0;
    setIndex += 1;
  }

  return {
    gameIndex,
    setIndex,
    pointsA,
    pointsB,
    gamesA,
    gamesB,
    setsA,
    setsB,
    games,
    sets,
    tiebreaks,
    inTiebreak,
    finished,
  };
}

/**
 * 从逐球流水重算整场进度。按实时态自带的赛制分派到两套体系。
 *
 * @param {Array<Object>} rallies
 * @param {Object} format 实时态本身（含 gamePoints 或 scoring）
 * @param {Object|null} [base] 折叠水位（见 folded.base）；不传表示从开场重算
 * @returns {Object} 见 replayPointRallies / replayTennisRallies
 */
function replayRallies(rallies, format, base = null) {
  if (scoringOf(format) === 'tennis') return replayTennisRallies(rallies, format, base);
  return replayPointRallies(rallies, format, base);
}

/** 把重算结果摊成实时态里的派生字段 */
function derivedFields(progress) {
  const fields = {
    gameIndex: progress.gameIndex,
    pointsA: progress.pointsA,
    pointsB: progress.pointsB,
    gamesA: progress.gamesA,
    gamesB: progress.gamesB,
    status: progress.finished ? LIVE_STATUS.FINISHED : LIVE_STATUS.LIVE,
  };
  // 网球多两级：盘数与本盘序号。point 体系不写这些字段，
  // 免得老记录上凭空多出几个恒为 0 的键。
  if (progress.sets) {
    fields.setIndex = progress.setIndex;
    fields.setsA = progress.setsA;
    fields.setsB = progress.setsB;
    fields.inTiebreak = progress.inTiebreak === true;
  }
  return fields;
}

/** 一局之内 0/15/30/40 的文案（网球） */
const TENNIS_POINT_TEXT = ['0', '15', '30', '40'];

/**
 * 把一局之内的原始球数翻成网球分数。
 *
 * 40:40 之后是占先（AD）：一方领先 1 分显示 AD，另一方仍显示 40；
 * 无占先（noAd）没有占先态，双方都显示 40，下一分直接定胜负。
 * 抢七不做这个换算——抢七就是数分，7:5、9:7 直接显示数字。
 *
 * @param {number} points
 * @param {number} other
 * @param {Object} [options]
 * @param {boolean} [options.noAd]
 * @param {boolean} [options.tiebreak]
 * @returns {string}
 */
function tennisPointText(points, other, options = {}) {
  if (options.tiebreak) return String(points);
  if (points >= 3 && other >= 3) {
    if (points === other) return '40';
    if (points === other + 1) return options.noAd ? '40' : 'AD';
    return '40';
  }
  return TENNIS_POINT_TEXT[Math.min(points, 3)];
}

/** 折叠水位：窗口起点处的派生状态；没折叠过返回 null。 */
function baseOf(state) {
  const folded = state && state.folded;
  return (folded && folded.base) ? folded.base : null;
}

/** 已折叠的球数：撤销被拒时用它区分「还没判过」与「太早了，已经折叠」。 */
function foldedCount(state) {
  return Number((state && state.folded && state.folded.count) || 0);
}

/**
 * 把窗口左边「已经打完的那几局」折叠成摘要（2026-10-23 第三轮 X-13）。
 *
 * 【为什么只在局边界切】
 * 切点必须让窗口起点是「新一局开局」（小分 0:0、不在抢七）。否则重算要从半局
 * 中间续算，`folded.base` 就得多存一份半局状态——多一个会漂移的字段，撤销时
 * 极易与全量重算分叉。按局切则 base 只有局数 / 盘数这几个整数。
 *
 * 【怎么找切点】从「留住 RALLY_KEEP 球」这条线往回试，第一个让小分归零的
 * 位置就是上一局的终点。试的次数不超过一局长度，而折叠次数与局数同阶，
 * 所以这一步的开销可以忽略。
 *
 * @param {Object} state 已算好派生字段的实时态
 * @returns {Object} 折叠后的实时态；找不到合法切点（例如一局特别长）时原样返回
 */
function foldRallies(state) {
  const rallies = Array.isArray(state.rallies) ? state.rallies : [];
  if (rallies.length <= RALLY_FOLD_AT) return state;

  const base = baseOf(state);
  const floor = rallies.length - RALLY_KEEP;

  for (let cut = floor; cut >= 1; cut -= 1) {
    const progress = replayRallies(rallies.slice(0, cut), state, base);
    // 局边界：整场没结束、本局还没开分、也不在抢七中间
    if (progress.finished) continue;
    if (progress.pointsA !== 0 || progress.pointsB !== 0) continue;
    if (progress.inTiebreak === true) continue;

    const folded = state.folded || {};
    return {
      ...state,
      rallies: rallies.slice(cut),
      folded: {
        count: (Number(folded.count) || 0) + cut,
        base: {
          gameIndex: progress.gameIndex,
          gamesA: progress.gamesA,
          gamesB: progress.gamesB,
          setsA: progress.setsA || 0,
          setsB: progress.setsB || 0,
          setIndex: progress.setIndex || 0,
        },
        // 已折叠的局 / 盘 / 抢七摘要：定稿拼正式比分要用，不能丢
        games: [...(folded.games || []), ...progress.games],
        sets: [...(folded.sets || []), ...(progress.sets || [])],
        tiebreaks: [...(folded.tiebreaks || []), ...(progress.tiebreaks || [])],
      },
    };
  }
  return state;
}

/**
 * 判一球：+1 分；够分且领先 2 → 记一局、进下一局；局数过半 → finished。
 *
 * @param {Object} state 当前实时态
 * @param {'A'|'B'} side 这一球判给谁
 * @param {Object} [options]
 * @param {string} [options.rallyId] 客户端生成的一球编号，用于服务端幂等去重
 * @returns {Object} 新的实时态（不改原对象）
 */
function applyRally(state, side, options = {}) {
  if (!state || (side !== SIDE.A && side !== SIDE.B)) return state;
  const rallyId = options.rallyId ? String(options.rallyId) : '';
  const rally = { g: state.gameIndex, side };
  if (rallyId) rally.id = rallyId;

  const rallies = [...(state.rallies || []), rally];
  const next = { ...state, rallies, ...derivedFields(replayRallies(rallies, state, baseOf(state))) };
  return foldRallies(next);
}

/**
 * 撤销最后一球（弹 rallies 尾部并重算）。
 * 若撤销的是决定性的那一球，整场随即退回「进行中」。
 *
 * 【折叠之后撤不到开场】窗口之外（已折叠）的球无法撤销——这正是本项的产品
 * 口径变更：可回溯范围从「开场」收窄为「最近一局 + 最近 RALLY_KEEP 球」。
 * 窗口为空时原样返回，由服务层给「太早了」的文案。
 *
 * @param {Object} state 当前实时态
 * @returns {Object} 新的实时态；没有可撤销的球时原样返回
 */
function undoRally(state) {
  const rallies = state && Array.isArray(state.rallies) ? state.rallies : [];
  if (rallies.length === 0) return state;
  const next = rallies.slice(0, -1);
  return { ...state, rallies: next, ...derivedFields(replayRallies(next, state, baseOf(state))) };
}

/**
 * 这份实时态是不是已经定稿（正式比分已经交出去了）。
 *
 * 【为什么需要一个标记，而不是看状态】
 * 「整场打完」（status = finished）与「定稿交分」隔着一段时间：打完还能
 * 撤掉制胜那一球重来，这是正常的临场更正。定稿之后再撤就不同了——正式
 * 比分已经写进比赛记录，此时把实时态退回「进行中」，查看端会看到一场
 * 还没打完的比赛，而备战表里它已经有成绩了。两者各说各话，且比赛一旦
 * 被对手确认（status 转已生效），实时台就永远停在「进行中」再也定不了稿。
 * 所以定稿那一刻在实时态上盖个章，之后只读。
 *
 * @param {Object} state
 * @returns {boolean}
 */
function isFinalized(state) {
  return Boolean(state && state.finalizedAt);
}

/**
 * 这一球是不是已经记过（幂等去重）。
 * 断线重发 / 连点会给同一个 rallyId 发两次，服务端据此判重。
 *
 * 【只覆盖窗口，这是有意的取舍】（2026-10-23 第三轮 X-13）
 * 折叠掉的球不在 `rallies` 里，判重也就查不到它们。实际够用：判球失败时客户端
 * 是「提示 + 整屏对账（resync）」，不重发同一编号；真正的重复只来自同一次投递
 * 被投两遍，与折叠点至少隔 RALLY_KEEP 球。为堵住「跨 20 球之后重发」而常驻一份
 * id 清单，会让文档又长回去，不划算——这条边界写在验收记录里，不是遗漏。
 *
 * @param {Object} state
 * @param {string} rallyId
 * @returns {boolean}
 */
function hasRally(state, rallyId) {
  const id = rallyId ? String(rallyId) : '';
  if (!id || !state) return false;
  return (state.rallies || []).some((rally) => rally && rally.id === id);
}

/**
 * 给查看端的视图模型。
 *
 * 只给「看比分」需要的字段：当前局比分、局数、第几局、谁领先、是否结束。
 * 不吐逐球流水——查看端不需要，也省流量（轮询每 2 秒一次）。
 *
 * @param {Object} state
 * @returns {Object|null}
 */
function liveScoreOf(state) {
  if (!state) return null;
  const finished = state.status === LIVE_STATUS.FINISHED;
  const isTennis = state.scoring === 'tennis';
  const tiebreak = isTennis && state.inTiebreak === true;
  const noAd = state.noAd === true;

  return {
    matchId: state.matchId,
    pointsA: state.pointsA,
    pointsB: state.pointsB,
    gamesA: state.gamesA,
    gamesB: state.gamesB,
    gameIndex: state.gameIndex,
    status: state.status,
    finished,
    // 谁领先，供查看端高亮；平局为 ''
    leading: state.pointsA === state.pointsB ? '' : state.pointsA > state.pointsB ? SIDE.A : SIDE.B,
    gamePoints: state.gamePoints,
    bestOf: state.bestOf,
    // —— 网球专属 ——
    // 大比分是「盘」，gamesA/gamesB 退化为「本盘局分」，points 退化为「本局分」
    scoring: isTennis ? 'tennis' : 'point',
    setsA: isTennis ? state.setsA || 0 : 0,
    setsB: isTennis ? state.setsB || 0 : 0,
    setIndex: isTennis ? state.setIndex || 0 : 0,
    inTiebreak: tiebreak,
    noAd,
    pointTextA: isTennis ? tennisPointText(state.pointsA, state.pointsB, { noAd, tiebreak }) : String(state.pointsA),
    pointTextB: isTennis ? tennisPointText(state.pointsB, state.pointsA, { noAd, tiebreak }) : String(state.pointsB),
    // 定稿后写回正式比分，查看端可据此显示终局
    updatedAt: state.updatedAt || null,
  };
}

/**
 * 定稿：把逐球流水转成正式比分，交给现有的 fillScheduledMatch / submitMatch。
 *
 * 只取「打完的单元」——进行中的那一局（还有分没打完）不该进正式比分，
 * 否则 11:9 11:5 会被写成 11:9 5:2 这种没有胜负的半局。
 *
 * 网球取的是**盘**（不是局）：scoreA = [6, 7] 这样的每盘局数。
 * 抢七小分另出一份 tiebreaks，用来还原 7:6(5) 里的括号。
 *
 * 【必须与 folded 摘要合并】（2026-10-23 第三轮 X-13）窗口只留最近几十球，
 * 已折叠的局记在 `folded.games / sets / tiebreaks` 里。只算窗口那一份会把
 * 前面的局整段漏掉——正式比分从「3:1」变成「1:1」，且不报错。
 *
 * @param {Object} state
 * @returns {{scoreA:number[], scoreB:number[], tiebreaks?:Array<Object>}}
 */
function toOfficialScores(state) {
  if (!state) return { scoreA: [], scoreB: [] };
  const progress = replayRallies(state.rallies, state, baseOf(state));
  const folded = state.folded || {};

  if (state.scoring === 'tennis') {
    // 已折叠的盘 + 窗口里打完的盘，按先后拼起来（摘要留在同一条文档里）
    const sets = [...(folded.sets || []), ...progress.sets];
    const tiebreaks = [...(folded.tiebreaks || []), ...progress.tiebreaks];
    return {
      scoreA: sets.map((set) => set.a),
      scoreB: sets.map((set) => set.b),
      tiebreaks: tiebreaks.map((item) => ({ ...item })),
    };
  }

  const games = [...(folded.games || []), ...progress.games];
  return {
    scoreA: games.map((game) => game.a),
    scoreB: games.map((game) => game.b),
  };
}

module.exports = {
  LIVE_STATUS,
  SIDE,
  RALLY_KEEP,
  RALLY_FOLD_AT,
  liveKey,
  createLive,
  formatOf,
  gameWon,
  replayRallies,
  replayPointRallies,
  replayTennisRallies,
  baseOf,
  foldedCount,
  foldRallies,
  applyRally,
  undoRally,
  hasRally,
  isFinalized,
  liveScoreOf,
  tennisPointText,
  toOfficialScores,
};
