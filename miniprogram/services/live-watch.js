/**
 * 实时比分同步适配器（全仓唯一的轮询出口）
 * ============================================================
 * 页面只认这一个出口，不认轮询。`setInterval` 只允许出现在这里——
 * 页面绝不自建定时器，这样「多久刷一次、什么时候不刷」是可被单测覆盖的
 * （假定时器 + 断言「值没变不回调」），而不是散在各页里靠自觉。
 *
 * 【当前实现 = 短轮询】
 * Q2 已拍板用短轮询，不做长连接。将来若要换成 WebSocket，只改这个文件，
 * 页面一行不用动——这正是把它单独拎出来的理由。
 *
 * 【为什么不频繁刷新】
 * 1. matchIds 为空 ⇒ 完全不启表，连一次请求都不发；
 * 2. 有比赛时每 2 秒调一次 getLiveScores（批量，只回比分字段）；
 * 3. 拿到结果先与上一次逐场比对，只有值真的变了才 onUpdate——
 *    比赛进行中但比分没动时，一个字节都不 setData；
 * 4. 页面 onHide ⇒ pause() 停表；onShow ⇒ resume() 立即补一次再续表；
 * 5. 单次请求失败静默跳过这一拍，不弹错、不重试堆积，下一拍照常。
 *
 * 【首屏为什么不会「先 0:0 再跳」】
 * 既有读接口（getMatchRecords 等）已经带上实时比分，页面首次渲染就是实时值；
 * 适配器只负责此后的增量。
 *
 * 【取数器为什么必须由调用方注入】
 * 从前这里是「不传就走旧栈门面的 `getLiveScores`」。协议 1 已定完全下线
 * （P10），那条缺省路径一旦留下，就成了「页面改接 S2 之后，适配器还在悄悄
 * 读旧台账」的隐患——两处各说各话，且只在真机上才看得出来。现在改为**必填**：
 * 名单非空却给不出取数器，订阅当场报错。三个调用点（普通比赛面板、个人赛事
 * 详情、学院赛详情）本就都传了 `getSchoolLiveScores`，行为不变。
 * ============================================================
 */

/** 轮询间隔（毫秒）。要调频率只动这一处。 */
const POLL_INTERVAL = 2000;

/**
 * 没有比赛在打时的间隔（毫秒）。
 *
 * 【为什么要放宽】（2026-10-21 审查 P1-6）
 * 每拍请求都要重新解析身份（6 次点读）再按场次读实时比分，10 场观众一分钟
 * 就是 480 次读。而「比赛还没开打 / 已经打完」的场次占大多数时间，2 秒一问
 * 完全是空转。连续 IDLE_AFTER 拍都没有 live 场次时降到 8 秒，一旦有人开台
 * （返回里出现 status==='live'）立刻恢复 2 秒。
 */
const IDLE_INTERVAL = 8000;

/** 连续多少拍没有 live 场次才降频。设 3 是为了不误伤「刚点开始还没同步」的窗口。 */
const IDLE_AFTER = 3;

/** 失败退避的上限（毫秒）。 */
const BACKOFF_MAX = 30000;

/**
 * 当前订阅。同一时刻只允许一个页面在轮询——小程序同一时刻只有一个页面
 * 可见，用单例既省定时器，也天然做到「重新订阅即停旧表」。
 */
let session = null;

/**
 * 比分指纹：只取与「看比分」有关的字段。
 * updatedAt 每写一次就变，但它不改变观众看到的东西；把它排除掉，
 * 才能在「有人改了什么却与比分无关」时不惊动页面。
 *
 * @param {Object} view liveScoreOf 的返回值
 * @returns {string}
 */
function fingerprint(view) {
  if (!view) return '';
  return [
    view.pointsA,
    view.pointsB,
    view.gamesA,
    view.gamesB,
    // 网球：盘分与抢七记录也要进指纹，否则只变盘分时观众页不刷新。
    view.setsA,
    view.setsB,
    Array.isArray(view.tiebreaks) ? view.tiebreaks.length : '',
    view.gameIndex,
    view.status,
    // 篮球同一入口：换节和结束也要通知，不只比较总分。
    view.revision,
    view.scoreText,
  ].join(':');
}

/**
 * 与上一拍的指纹比一比，完全相同就返回 true（无需回调）。
 * @param {Map<string,string>} prev
 * @param {Array<Object>} views
 * @returns {boolean}
 */
function sameAsLast(prev, views) {
  if (!prev) return false;
  if (prev.size !== views.length) return false;
  for (const view of views) {
    if (!view || prev.get(view.matchId) !== fingerprint(view)) return false;
  }
  return true;
}

/** 把这一拍的结果摊成 matchId → 指纹 */
function toMap(views) {
  const map = new Map();
  for (const view of views || []) {
    if (view && view.matchId) map.set(view.matchId, fingerprint(view));
  }
  return map;
}

/** 停掉某个订阅的定时器（不动订阅本身） */
function clearTimer(target) {
  if (target && target.timer !== null) {
    clearInterval(target.timer);
    target.timer = null;
  }
}

/**
 * 拉一次并比对。失败静默跳过，绝不抛出——轮询失败不该震到页面。
 * @param {Object} target
 */
async function poll(target) {
  if (!target || target.stopped || target.paused || target.inFlight) return undefined;
  target.inFlight = true;

  let views;
  let failed = false;
  try {
    views = await target.fetch(target.ids);
  } catch (err) {
    // 这一拍失败：不回调、不重试，但**要退避**——故障期所有客户端若都保持
    // 原节奏猛打，恢复期会被打得更久（2026-10-21 审查 P2-12）。
    failed = true;
  } finally {
    target.inFlight = false;
  }
  // 等待期间页面可能已经取消订阅或隐藏了
  if (!target || target.stopped || target.paused) return undefined;

  if (failed) {
    target.failStreak += 1;
    tuneInterval(target);
    return undefined;
  }
  target.failStreak = 0;

  const list = Array.isArray(views) ? views : [];
  // 有 live 场次说明比赛正在打，保持高频；否则累计「空转」拍数，到阈值降频。
  const hasLive = list.some((view) => view && view.status === 'live');
  target.idleStreak = hasLive ? 0 : target.idleStreak + 1;

  if (!sameAsLast(target.last, list)) {
    target.last = toMap(list);
    target.onUpdate(list);
  }

  // 已经打完的场次不必再轮询。页面侧的 liveIds 本就排除 finished 的场次，
  // 但那是订阅那一刻算的；一场比赛是在轮询途中打完的，这里同步把名单缩一缩，
  // 免得对着一场已经结束的比赛空转。全部打完就直接停表。
  const finished = new Set(
    list.filter((view) => view && view.finished && view.matchId).map((view) => view.matchId)
  );
  if (finished.size > 0) {
    const remaining = target.ids.filter((id) => !finished.has(id));
    if (remaining.length !== target.ids.length) {
      target.ids = remaining;
      if (target.last) for (const id of finished) target.last.delete(id);
      if (remaining.length === 0) {
        clearTimer(target);
        return undefined;
      }
    }
  }
  tuneInterval(target);
  return undefined;
}

/** 记下当前应当使用的间隔（不重建定时器）。 */
function desiredInterval(target) {
  if (target.failStreak > 0) {
    return Math.min(POLL_INTERVAL * Math.pow(2, target.failStreak), BACKOFF_MAX);
  }
  return target.idleStreak >= IDLE_AFTER ? IDLE_INTERVAL : POLL_INTERVAL;
}

/** 间隔变了才重建定时器（setInterval 的周期不能原地修改）。 */
function tuneInterval(target) {
  if (!target || target.stopped || target.paused || target.ids.length === 0) return;
  const next = desiredInterval(target);
  if (next === target.interval) return;
  target.interval = next;
  schedule(target);
}

/** 起表（为空名单时什么也不做） */
function schedule(target) {
  clearTimer(target);
  if (target.ids.length === 0) return;
  const interval = target.interval || POLL_INTERVAL;
  target.interval = interval;
  target.timer = setInterval(() => {
    poll(target);
  }, interval);
  // Node 页面装配环境不因后台轮询常驻；微信的数值句柄没有此方法。
  if (target.timer && typeof target.timer.unref === 'function') target.timer.unref();
}

/** 停掉当前订阅 */
function stopSession() {
  if (!session) return;
  session.stopped = true;
  clearTimer(session);
  session = null;
}

/**
 * 给订阅一个可取消、可暂停的句柄。
 * 句柄本身是函数（`off()` 即取消订阅），另挂 pause / resume 供页面
 * 的 onHide / onShow 使用。已失效的句柄调用 pause/resume 一律是空操作。
 *
 * @param {Object} target
 * @returns {Function & {pause:Function, resume:Function}}
 */
function handleFor(target) {
  const off = () => {
    if (session === target) stopSession();
    else target.stopped = true;
  };
  off.pause = () => {
    if (session !== target) return;
    target.paused = true;
    clearTimer(target);
  };
  off.resume = () => {
    if (session !== target) return;
    target.paused = false;
    // 回前台当作一次重新开始：退避与降频都清零，立即补一拍再按 2 秒跑。
    target.failStreak = 0;
    target.idleStreak = 0;
    target.interval = POLL_INTERVAL;
    poll(target); // 立即补一次，消掉回前台的空窗
    schedule(target);
  };
  return off;
}

/**
 * 订阅一组比赛的实时比分。
 *
 * matchIds 变化时直接再调一次即可——旧的会先被停掉，天然完成重订阅。
 * 返回的句柄在页面 onUnload 必须调用；onHide / onShow 调 pause / resume。
 *
 * @param {string[]} matchIds 关心的比赛编号；空数组 ⇒ 完全不启表
 * @param {Function} onUpdate 比分真的变了才被调用，参数是实时视图数组
 * @param {{fetch:Function}} options 取数器（**必填**，名单非空时）。
 *   学校维度页面传 `getSchoolLiveScores`：它的返回是 `{ok, scores}`，
 *   调用方摊平成「给一组编号、回一组比分视图」再交进来。适配器只认这一件事，
 *   不关心数据从哪来。
 * @returns {Function & {pause:Function, resume:Function}} 取消订阅
 * @throws {TypeError} 名单非空却没给取数器——不留「悄悄读旧栈门面」的缺省路径
 */
function watchLiveScores(matchIds, onUpdate, options = {}) {
  stopSession();

  const ids = [...new Set((Array.isArray(matchIds) ? matchIds : []).filter(Boolean))];

  // 空名单：本就不启表、不请求，取数器可有可无
  const fetch = typeof options.fetch === 'function' ? options.fetch : null;
  if (ids.length > 0 && !fetch) {
    throw new TypeError(
      'watchLiveScores 需要 options.fetch：协议 1 门面已按 P10 下线，没有缺省取数路径'
    );
  }

  const target = {
    ids,
    onUpdate: typeof onUpdate === 'function' ? onUpdate : () => {},
    fetch,
    last: null,
    timer: null,
    paused: false,
    stopped: false,
    // 自适应间隔用：连续失败拍数（指数退避）、连续无 live 拍数（降频）、
    // 当前 setInterval 周期（变了才重建定时器）。
    failStreak: 0,
    idleStreak: 0,
    interval: POLL_INTERVAL,
  };
  session = target;

  // 没有进行中的比赛：不启表，也不发请求
  if (ids.length === 0) return handleFor(target);

  poll(target); // 订阅时立即补一次
  schedule(target);
  return handleFor(target);
}

module.exports = { watchLiveScores, POLL_INTERVAL };
