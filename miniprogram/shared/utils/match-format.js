/**
 * 比赛赛制与比分校验
 * ============================================================
 * 本项目有两套计分体系，差异在**层级数**上：
 *
 *   ① scoring = 'point'（默认，匹克球 / 乒乓 / 羽毛球）
 *      分 → 局 → 场，两级
 *        分制 gamePoints：11 / 15 / 21
 *        局制 bestOf：    1 / 3 / 5（一局一胜 / 三局两胜 / 五局三胜）
 *
 *   ② scoring = 'tennis'（网球）
 *      分 → 局 → 盘 → 场，三级
 *        一局恒定 4 分（0/15/30/40，40:40 后需连得 2 分）
 *        一盘 setGames 局：6 局标准盘 / 4 局短盘，到 6:6（短盘 4:4）抢七
 *        盘制 bestOf：    1 / 3（一盘决胜 / 三盘两胜）
 *
 * 【两套体系的数组语义不同，这是全案最容易搞混的一处】
 *   point  的 scoreA[i] = 第 i 局我方得分（如 11:9）
 *   tennis 的 scoreA[i] = 第 i 盘我方局数（如 6:4、7:6）
 * 数组形状与 bestOf 的含义完全一致（bestOf 都是"打几盘/几局"），
 * 所以上层（等级分、战绩、formatScore）不必判断体系。
 *
 * 【point 的胜负判定：先到目标分且领先 2 分，不封顶】
 * 这是匹克球的标准规则。校验时绝不能写「胜方必须正好等于 11」——
 * 11 分制本来就可以打成 13:11、15:13，21 分制能出现 23:21。正确判据只有两条：
 *   1. 胜方分数 >= 目标分
 *   2. 胜方领先至少 2 分
 * 于是 11:9、12:10、13:11、17:15 都合法，而 11:10 和 10:8 都不合法。
 *
 * 【tennis 的盘比分：7:6 是合法的 1 分差，这是与 point 最大的不同】
 * ITF 规则：先胜 6 局且领先 2 局拿下一盘；6:6 打抢七，抢七胜者以 7:6 拿下。
 * 因此合法盘比分只有三类：
 *   6:0 ~ 6:4   到 6 局且领先 >= 2
 *   7:5         5:5 之后连下两局
 *   7:6         抢七决定（1 局差，不能套用 point 的"领先 2"判据）
 * 而 6:5、6:6、7:4、8:6 都不合法。短盘把 6 换成 4，规则同构。
 *
 * 【为什么校验要写这么细】
 * 比分是唯一的事实来源，等级分、积分、排名全部由它推导。
 * 一个录错的比分（比如 11:10 这种没打完的局）会污染整条链路，
 * 而且事后很难发现。宁可在录入时被拦下来。
 * ============================================================
 */

/** 计分体系 */
const SCORING = {
  POINT: 'point',
  TENNIS: 'tennis',
};

/** 可选分制 */
const GAME_POINTS_OPTIONS = [11, 15, 21];

/** 可选局制 */
const BEST_OF_OPTIONS = [1, 3, 5];

/** 局制文案 */
const BEST_OF_LABEL = {
  1: '一局一胜',
  3: '三局两胜',
  5: '五局三胜',
};

/** 默认赛制：11 分制三局两胜，业余比赛最常用 */
const DEFAULT_FORMAT = { gamePoints: 11, bestOf: 3 };

/** 网球每盘局数：6 局标准盘 / 4 局短盘 */
const TENNIS_SET_GAMES_OPTIONS = [6, 4];

/** 网球盘制：一盘决胜 / 三盘两胜（ITF 的五盘两胜不在校内场景） */
const TENNIS_BEST_OF_OPTIONS = [1, 3];

/** 网球盘制文案 */
const TENNIS_BEST_OF_LABEL = {
  1: '一盘决胜',
  3: '三盘两胜',
};

/** 抢七分数。ITF 标准是 7 分且领先 2 分；决胜盘打 10 分的变体本项目不做 */
const TENNIS_TIEBREAK_POINTS = 7;

/** 默认网球赛制：一盘决胜、6 局标准盘、抢七、有占先 */
const DEFAULT_TENNIS_FORMAT = {
  scoring: SCORING.TENNIS,
  bestOf: 1,
  setGames: 6,
  tiebreakAt: 6,
  tiebreakPoints: TENNIS_TIEBREAK_POINTS,
  noAd: false,
};

/**
 * 赢下整场需要拿下的局数。
 * 单数局制取一半向上取整：3 局需 2 胜，5 局需 3 胜，1 局需 1 胜。
 *
 * @param {number} bestOf
 * @returns {number}
 */
function gamesToWin(bestOf) {
  return Math.ceil(bestOf / 2);
}

/**
 * 赛制属于哪套计分体系。缺省一律当 point——历史记录都没有 scoring 字段。
 * @param {Object} format
 * @returns {'point'|'tennis'}
 */
function scoringOf(format) {
  return format && format.scoring === SCORING.TENNIS ? SCORING.TENNIS : SCORING.POINT;
}

/**
 * 把网球赛制归一成可用于校验的形状，不合法返回 null。
 *
 * 只认两种组合：6 局盘 / 4 局盘，且抢七点就是本盘局数。
 * 「决胜盘打 10 分」「Advantage Set（不抢七）」这两个 ITF 变体本项目不做，
 * 传进来会被判不合法而不是被悄悄接受——接受一个不认识的赛制，比拒绝更危险。
 *
 * @param {Object} format
 * @returns {{scoring:string,bestOf:number,setGames:number,tiebreakAt:number,tiebreakPoints:number,noAd:boolean}|null}
 */
function normalizeTennisFormat(format) {
  if (!format || format.scoring !== SCORING.TENNIS) return null;

  const bestOf = Number(format.bestOf);
  const setGames = Number(format.setGames);
  const tiebreakAt = format.tiebreakAt === undefined || format.tiebreakAt === null
    ? setGames
    : Number(format.tiebreakAt);
  const tiebreakPoints = format.tiebreakPoints === undefined || format.tiebreakPoints === null
    ? TENNIS_TIEBREAK_POINTS
    : Number(format.tiebreakPoints);

  if (!TENNIS_BEST_OF_OPTIONS.includes(bestOf)) return null;
  if (!TENNIS_SET_GAMES_OPTIONS.includes(setGames)) return null;
  if (tiebreakAt !== setGames) return null;
  if (tiebreakPoints !== TENNIS_TIEBREAK_POINTS) return null;

  return { scoring: SCORING.TENNIS, bestOf, setGames, tiebreakAt, tiebreakPoints, noAd: format.noAd === true };
}

/**
 * 赛制是否受支持。按计分体系分派。
 * @param {Object} format
 * @returns {boolean}
 */
function isValidFormat(format) {
  if (!format) return false;
  if (format.scoring === SCORING.TENNIS) return normalizeTennisFormat(format) !== null;
  return Boolean(
    GAME_POINTS_OPTIONS.includes(format.gamePoints) && BEST_OF_OPTIONS.includes(format.bestOf)
  );
}

/**
 * 组装一个赛制对象，顺带校验。
 * @param {number} gamePoints
 * @param {number} bestOf
 * @returns {{gamePoints:number, bestOf:number, gamesToWin:number}}
 * @throws {Error} 分制或局制不受支持时抛出
 */
function createMatchFormat(gamePoints = DEFAULT_FORMAT.gamePoints, bestOf = DEFAULT_FORMAT.bestOf) {
  const format = { gamePoints, bestOf };
  if (!isValidFormat(format)) {
    throw new Error(
      `不支持的赛制：${gamePoints} 分制 / ${bestOf} 局制。` +
        `分制只能是 ${GAME_POINTS_OPTIONS.join('、')}，局制只能是 ${BEST_OF_OPTIONS.join('、')}`
    );
  }
  return { ...format, gamesToWin: gamesToWin(bestOf) };
}

/**
 * 组装一个网球赛制对象，顺带校验。
 *
 * 只暴露三个可变项：几盘（bestOf）、每盘几局（setGames）、有无占先（noAd）。
 * 抢七点恒等于本盘局数、恒为 7 分抢七——这两个是 ITF 标准，不给改。
 *
 * @param {Object} [options]
 * @param {number} [options.bestOf] 1 / 3
 * @param {number} [options.setGames] 6 / 4
 * @param {boolean} [options.noAd] 无占先：40:40 后下一分直接赢局
 * @returns {{scoring:string,bestOf:number,setGames:number,tiebreakAt:number,tiebreakPoints:number,noAd:boolean}}
 * @throws {Error} 取值不受支持时抛出
 */
function createTennisFormat(options = {}) {
  const format = {
    scoring: SCORING.TENNIS,
    bestOf: options.bestOf === undefined ? DEFAULT_TENNIS_FORMAT.bestOf : options.bestOf,
    setGames: options.setGames === undefined ? DEFAULT_TENNIS_FORMAT.setGames : options.setGames,
    tiebreakPoints: TENNIS_TIEBREAK_POINTS,
    noAd: options.noAd === true,
  };
  const normalized = normalizeTennisFormat(format);
  if (!normalized) {
    throw new Error(
      `不支持的网球赛制：${format.bestOf} 盘制 / 每盘 ${format.setGames} 局。` +
        `盘制只能是 ${TENNIS_BEST_OF_OPTIONS.join('、')}，每盘局数只能是 ${TENNIS_SET_GAMES_OPTIONS.join('、')}`
    );
  }
  return normalized;
}

/**
 * 赛制文案。
 *   point  → 11 分制 · 三局两胜
 *   tennis → 一盘决胜 · 每盘 6 局（6:6 抢七）[ · 无占先]
 *
 * @param {Object} format
 * @returns {string}
 */
function formatMatchFormat(format) {
  if (!isValidFormat(format)) return '';

  if (scoringOf(format) === SCORING.TENNIS) {
    const cfg = normalizeTennisFormat(format);
    const unit = cfg.setGames === 4 ? '每盘 4 局短盘' : '每盘 6 局';
    const parts = [TENNIS_BEST_OF_LABEL[cfg.bestOf], `${unit}（${cfg.setGames}:${cfg.setGames} 抢七）`];
    if (cfg.noAd) parts.push('无占先');
    return parts.join(' · ');
  }

  return `${format.gamePoints} 分制 · ${BEST_OF_LABEL[format.bestOf]}`;
}

/**
 * 校验单独一局的比分。
 *
 * @param {number} mine
 * @param {number} theirs
 * @param {number} gamePoints
 * @param {number} index 局序号（从 0 开始），仅用于错误提示
 * @returns {string[]} 错误信息，空数组表示合法
 */
function validateGame(mine, theirs, gamePoints, index) {
  const label = `第 ${index + 1} 局`;

  if (!Number.isInteger(mine) || !Number.isInteger(theirs)) {
    return [`${label}的比分必须是整数`];
  }
  if (mine < 0 || theirs < 0) {
    return [`${label}的比分不能是负数`];
  }
  if (mine === theirs) {
    return [`${label}必须分出胜负，不能打平（${mine}:${theirs}）`];
  }

  const high = Math.max(mine, theirs);
  const low = Math.min(mine, theirs);

  // 先判有没有人够分，再判分差。反过来的话，「10:8」会被报成
  // 「领先不足 2 分」，而真正的问题是这局根本没打到 11 分。
  if (high < gamePoints) {
    return [`${label}没有人打到 ${gamePoints} 分（${mine}:${theirs}）`];
  }
  if (high - low < 2) {
    return [`${label}胜方必须领先 2 分（${mine}:${theirs}）`];
  }

  return [];
}

/**
 * 校验单独一盘的盘比分（网球）。
 *
 * 只认三种形态，见文件头注：到局数且领先 2、多一局的 7:5、抢七的 7:6。
 * 6:5 这类「还差一局」的比分必须挡住——它不是合法的盘比分，而是没打完。
 *
 * @param {number} mine
 * @param {number} theirs
 * @param {Object} format 网球赛制
 * @param {number} index 盘序号（从 0 开始）
 * @returns {string[]} 错误信息，空数组表示合法
 */
function validateTennisSet(mine, theirs, format, index) {
  const label = `第 ${index + 1} 盘`;
  const cfg = normalizeTennisFormat(format);
  if (!cfg) return [`${label}的赛制不合法`];

  if (!Number.isInteger(mine) || !Number.isInteger(theirs)) {
    return [`${label}的比分必须是整数`];
  }
  if (mine < 0 || theirs < 0) {
    return [`${label}的比分不能是负数`];
  }
  if (mine === theirs) {
    return [`${label}必须分出胜负，不能打平（${mine}:${theirs}）`];
  }

  const high = Math.max(mine, theirs);
  const low = Math.min(mine, theirs);
  const full = cfg.setGames;

  const reachedWithMargin = high === full && low <= full - 2;
  const brokeAtFiveAll = high === full + 1 && low === full - 1;
  const wonTiebreak = high === full + 1 && low === full;

  if (reachedWithMargin || brokeAtFiveAll || wonTiebreak) return [];

  return [
    `${label}盘比分不合法：应打到 ${full} 局且领先 2 局（${full}:0–${full}:${full - 2}）、` +
      `或 ${full + 1}:${full - 1}、${full + 1}:${full}（抢七）。当前 ${mine}:${theirs}`,
  ];
}

/**
 * 逐局比对，判断每局谁赢。
 * @param {number[]} scoreA
 * @param {number[]} scoreB
 * @returns {Array<boolean|null>} true 表示 A 队赢下该局，null 表示比分为平（非法）
 */
function gameWinners(scoreA, scoreB) {
  return scoreA.map((value, index) => {
    if (value === scoreB[index]) return null;
    return value > scoreB[index];
  });
}

/**
 * 赛制对象 → 比赛记录上要落的字段。
 *
 * 两套体系字段不同，混着写会让另一端按错误的规则解释比分（网球记录多一个
 * 「每盘几局」，其余记录多一个「每局几分」）。凡是「把赛制写进记录」的地方
 * 都走这里，别各写一份 if。
 *
 * @param {Object} format
 * @returns {Object} 可直接展开进记录的赛制字段
 */
function formatFieldPatch(format) {
  if (isValidFormat(format) && scoringOf(format) === SCORING.TENNIS) {
    const cfg = normalizeTennisFormat(format);
    return {
      scoring: SCORING.TENNIS,
      bestOf: cfg.bestOf,
      setGames: cfg.setGames,
      tiebreakAt: cfg.tiebreakAt,
      tiebreakPoints: cfg.tiebreakPoints,
      noAd: cfg.noAd,
    };
  }
  return {
    gamePoints: format && format.gamePoints,
    bestOf: format && format.bestOf,
  };
}

/**
 * 从一条比赛记录 / DTO 里取出赛制。
 *
 * 记录上可能是两套体系之一：网球带 scoring/setGames，其余带 gamePoints。
 * 各处（实时台、录入页回填、展示）都要做这件事，收在这里免得各写一份
 * 判断，某处漏了就会把 6 局盘按 11 分制解释。
 *
 * @param {Object} record
 * @returns {Object|null} 合法赛制对象；记录上完全没有赛制字段时返回 null
 *   （展示层据此把 formatText 留成空串）。网球记录若字段残缺，退回网球默认值——
 *   它至少带了 scoring: 'tennis' 这个明确的信号，不属于「当年没记」。
 */
function formatOfRecord(record) {
  if (record && record.scoring === SCORING.TENNIS) {
    return normalizeTennisFormat({
      scoring: SCORING.TENNIS,
      bestOf: record.bestOf,
      setGames: record.setGames,
      tiebreakAt: record.tiebreakAt,
      tiebreakPoints: record.tiebreakPoints,
      noAd: record.noAd,
    }) || { ...DEFAULT_TENNIS_FORMAT };
  }
  const format = { gamePoints: record && record.gamePoints, bestOf: record && record.bestOf };
  // 老数据（加赛制字段之前录的比赛）没有 gamePoints / bestOf。这里刻意返回 null
  // 而不是兜底成默认赛制：列表页靠「config 为空 ⇒ formatText 为空串 ⇒ 模板 wx:if
  // 挡住这一行」来区分「真的写了赛制」和「当年没记」。想拿可直接用的赛制就走
  // defaultFormatOf / DEFAULT_FORMAT，别在这儿兜底。
  return isValidFormat(format) ? format : null;
}

/**
 * 整场校验的公共骨架。两套计分体系的差别只在「一个单元怎么算赢」，
 * 其余规则完全一致：单元数一致、不超上限、有一方拿够、决胜单元必须是最后一个。
 * 所以骨架只收一个校验单元的函数，配一个称呼（局 / 盘）。
 *
 * @param {Array<*>} scoreA
 * @param {Array<*>} scoreB
 * @param {number} bestOf
 * @param {Object} unit { noun, bestOfLabel, validateUnit(valueA, valueB, index) }
 * @returns {{valid:boolean, errors:string[], winner:'A'|'B'|null, gamesA:number, gamesB:number}}
 */
function validateUnits(scoreA, scoreB, bestOf, unit) {
  const empty = { valid: false, errors: [], winner: null, gamesA: 0, gamesB: 0 };
  const noun = unit.noun;

  if (!Array.isArray(scoreA) || !Array.isArray(scoreB)) {
    return { ...empty, errors: ['比分必须是数组'] };
  }
  if (scoreA.length === 0) {
    return { ...empty, errors: [`至少要录入 1 ${noun}比分`] };
  }
  if (scoreA.length !== scoreB.length) {
    return {
      ...empty,
      errors: [`两队${noun}数不一致（${scoreA.length} ${noun}对 ${scoreB.length} ${noun}）`],
    };
  }

  const need = gamesToWin(bestOf);
  const errors = [];

  if (scoreA.length > bestOf) {
    errors.push(`${unit.bestOfLabel}最多打 ${bestOf} ${noun}，当前录了 ${scoreA.length} ${noun}`);
  }

  // 逐个单元单独校验
  scoreA.forEach((value, index) => {
    errors.push(...unit.validateUnit(value, scoreB[index], index));
  });

  const winners = gameWinners(scoreA, scoreB);
  const gamesA = winners.filter((w) => w === true).length;
  const gamesB = winners.filter((w) => w === false).length;

  if (gamesA !== need && gamesB !== need) {
    errors.push(
      `${unit.bestOfLabel}需要有一方赢下 ${need} ${noun}才能结束，当前 ${gamesA} : ${gamesB}`
    );
  } else {
    // 已经分出胜负，那么决定性的那一单元必须是最后一个。
    // 否则就是录多了——比如三局两胜录成 11:9 11:9 11:9，
    // 第三局开打前比赛其实已经结束了。
    let reachedA = 0;
    let reachedB = 0;
    let decisive = -1;
    for (let i = 0; i < winners.length; i += 1) {
      if (winners[i] === true) reachedA += 1;
      if (winners[i] === false) reachedB += 1;
      if (reachedA === need || reachedB === need) {
        decisive = i;
        break;
      }
    }

    if (decisive !== winners.length - 1) {
      const extra = winners.length - decisive - 1;
      errors.push(`比赛在第 ${decisive + 1} ${noun}就已分出胜负，多录了 ${extra} ${noun}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    winner: gamesA > gamesB ? 'A' : gamesB > gamesA ? 'B' : null,
    gamesA,
    gamesB,
  };
}

/**
 * 校验整场比分，并给出胜方。按赛制自动分派到两套计分体系。
 *
 * 返回的 gamesA / gamesB 是「赢下的单元数」：point 模式是局数，tennis 模式是盘数。
 *
 * @param {number[]} scoreA point：逐局得分；tennis：逐盘局数
 * @param {number[]} scoreB 同上
 * @param {Object} format 见 isValidFormat
 * @returns {{valid:boolean, errors:string[], winner:'A'|'B'|null, gamesA:number, gamesB:number}}
 *
 * @example
 * validateMatchScore([11, 9, 11], [9, 11, 9], { gamePoints: 11, bestOf: 3 });
 * // => { valid: true, errors: [], winner: 'A', gamesA: 2, gamesB: 1 }
 * validateMatchScore([6, 4], [4, 6], { scoring: 'tennis', bestOf: 3, setGames: 6, tiebreakAt: 6, tiebreakPoints: 7, noAd: false });
 * // => 还没打完（1:1），errors 说明还差一盘
 */
function validateMatchScore(scoreA, scoreB, format) {
  const empty = { valid: false, errors: [], winner: null, gamesA: 0, gamesB: 0 };

  if (!isValidFormat(format)) {
    return { ...empty, errors: ['赛制不合法，无法校验比分'] };
  }

  if (scoringOf(format) === SCORING.TENNIS) {
    const cfg = normalizeTennisFormat(format);
    return validateUnits(scoreA, scoreB, cfg.bestOf, {
      noun: '盘',
      bestOfLabel: TENNIS_BEST_OF_LABEL[cfg.bestOf],
      validateUnit: (value, other, index) => validateTennisSet(value, other, cfg, index),
    });
  }

  return validateUnits(scoreA, scoreB, format.bestOf, {
    noun: '局',
    bestOfLabel: BEST_OF_LABEL[format.bestOf],
    validateUnit: (value, other, index) => validateGame(value, other, format.gamePoints, index),
  });
}

/** 网球一局之内：先得 4 分且领先 2；无占先时 40:40 后下一分直接赢局 */
const TENNIS_POINTS_IN_GAME = 4;

/**
 * 一局是否打完（网球）。
 * @param {number} points
 * @param {number} other
 * @param {boolean} noAd
 * @returns {boolean}
 */
function tennisGameWon(points, other, noAd) {
  if (points < TENNIS_POINTS_IN_GAME) return false;
  return noAd ? points - other >= 1 : points - other >= 2;
}

/**
 * 一盘是否打完（网球）。局面分已定，只看局数：
 *   6:0–6:4（到 6 局且领先 2）、7:5、7:6（抢七后）
 * 抢七那一路由状态机直接判出 7:6，这里也一并认。
 *
 * @param {number} games
 * @param {number} other
 * @param {number} setGames
 * @returns {boolean}
 */
function tennisSetWon(games, other, setGames) {
  if (games >= setGames && games - other >= 2) return true;
  return games === setGames + 1;
}

module.exports = {
  SCORING,
  GAME_POINTS_OPTIONS,
  BEST_OF_OPTIONS,
  BEST_OF_LABEL,
  DEFAULT_FORMAT,
  TENNIS_SET_GAMES_OPTIONS,
  TENNIS_BEST_OF_OPTIONS,
  TENNIS_BEST_OF_LABEL,
  TENNIS_TIEBREAK_POINTS,
  TENNIS_POINTS_IN_GAME,
  DEFAULT_TENNIS_FORMAT,
  scoringOf,
  normalizeTennisFormat,
  formatFieldPatch,
  formatOfRecord,
  gamesToWin,
  isValidFormat,
  createMatchFormat,
  createTennisFormat,
  formatMatchFormat,
  validateGame,
  validateTennisSet,
  tennisGameWon,
  tennisSetWon,
  gameWinners,
  validateMatchScore,
};
