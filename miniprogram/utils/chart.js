/**
 * 等级分曲线
 * ============================================================
 * 【为什么自己画】
 * 小程序生态里的图表库动辄上百 KB，而我们只需要一条折线。
 * 为一条线引入一个库，包体积、兼容性、维护成本都不划算。
 *
 * 【为什么把几何计算和绘制分开】
 * 绘制要动 canvas，在 Node 里跑不了；但「第 3 个点应该落在哪个像素」
 * 这类算术才是容易出错的地方。于是拆成两层：
 *   computeChartGeometry()  纯函数，只看数值，可以完整测试
 *   drawLineChart()         只负责把算好的坐标画出来，不含任何判断
 * 这样一来，图表最容易出错的部分是被测试覆盖的。
 *
 * 【为什么要有最小跨度】
 * 如果某人分数一直在 1000~1005 之间徘徊，按真实范围铺满整张图，
 * 画出来会是一条剧烈起伏的曲线，看着像天天在进步，其实什么都没发生。
 * 所以强制一个最小跨度，让「没什么变化」看起来真的就是没什么变化。
 * ============================================================
 */

/** 分数波动小于这个跨度时，按这个跨度绘制。避免把微小波动放大成剧烈震荡。 */
const MIN_RANGE = 60;

/**
 * 求出「好看」的刻度间隔：1、2、5 及其 10 的幂次。
 * 这样刻度值会落在 1050、1100 这样的整数上，而不是 1037.5。
 *
 * @param {number} range 数值跨度
 * @param {number} targetCount 期望的刻度条数
 * @returns {number}
 */
function niceStep(range, targetCount = 4) {
  if (!(range > 0)) return 1;

  const raw = range / targetCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;

  let factor;
  if (normalized <= 1) factor = 1;
  else if (normalized <= 2) factor = 2;
  else if (normalized <= 5) factor = 5;
  else factor = 10;

  return factor * magnitude;
}

/**
 * 计算折线的几何信息。
 *
 * @param {Array<number>} values 按时间升序的数值序列
 * @param {Object} options
 * @param {number} options.width 画布宽度（px）
 * @param {number} options.height 画布高度（px）
 * @param {number} [options.paddingX=8] 左右留白
 * @param {number} [options.paddingY=16] 上下留白
 * @param {number} [options.minRange=60] 最小纵轴跨度
 * @param {number} [options.reference] 参考线数值（通常是入池起始分）
 * @returns {Object} 无数据时返回 { empty: true }
 */
function computeChartGeometry(values, options = {}) {
  const {
    width,
    height,
    paddingX = 8,
    paddingY = 16,
    minRange = MIN_RANGE,
    reference,
  } = options;

  const list = Array.isArray(values) ? values.filter((v) => Number.isFinite(v)) : [];
  if (list.length === 0) {
    return { empty: true };
  }

  // ---------- 1. 纵轴范围 ----------
  let lo = Math.min(...list);
  let hi = Math.max(...list);

  // 参考线也要落在可视范围内，否则它会被画到画布外面
  if (Number.isFinite(reference)) {
    lo = Math.min(lo, reference);
    hi = Math.max(hi, reference);
  }

  const mid = (lo + hi) / 2;
  if (hi - lo < minRange) {
    lo = mid - minRange / 2;
    hi = mid + minRange / 2;
  }

  // 上下各留 10% 的余量，曲线不会贴着边框
  const margin = (hi - lo) * 0.1;
  lo -= margin;
  hi += margin;

  // ---------- 2. 刻度 ----------
  const step = niceStep(hi - lo);
  const grid = [];
  for (let value = Math.ceil(lo / step) * step; value <= hi; value += step) {
    // 浮点累加会攒出 1049.9999999，统一取整到 step 的量级
    grid.push(Number(value.toFixed(6)));
  }

  // ---------- 3. 坐标映射 ----------
  const plotLeft = paddingX;
  const plotRight = width - paddingX;
  const plotTop = paddingY;
  const plotBottom = height - paddingY;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const yOf = (value) => {
    if (hi === lo) return plotTop + plotHeight / 2;
    return plotBottom - ((value - lo) / (hi - lo)) * plotHeight;
  };
  const xOf = (index) => {
    if (list.length === 1) return plotLeft + plotWidth / 2;
    return plotLeft + (index / (list.length - 1)) * plotWidth;
  };

  return {
    empty: false,
    min: lo,
    max: hi,
    dataMin: Math.min(...list),
    dataMax: Math.max(...list),
    plot: { left: plotLeft, right: plotRight, top: plotTop, bottom: plotBottom },
    points: list.map((value, index) => ({ x: xOf(index), y: yOf(value), value, index })),
    grid: grid.map((value) => ({ value, y: yOf(value) })),
    reference: Number.isFinite(reference) ? { value: reference, y: yOf(reference) } : null,
  };
}

/**
 * 把算好的几何信息画到 canvas 上。
 *
 * 【为什么所有绘制参数都要传进来】
 * 这个函数只做「照着坐标画」，不做任何取值判断。颜色、线宽这类
 * 样式集中由页面传，主题要改时不必翻绘图代码。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} geometry computeChartGeometry 的返回值
 * @param {Object} [style]
 * @param {string} [style.lineColor='#b23a2e']
 * @param {string} [style.fillColor='rgba(178,58,46,0.10)']
 * @param {string} [style.gridColor='#e5e7eb']
 * @param {string} [style.textColor='#9ca3af']
 * @param {string} [style.font='10px sans-serif']
 * @param {number} [style.lineWidth=2]
 * @param {number} [style.labelOffset=14] 刻度文字与右边框的距离
 * @param {number[]} [style.markedIndexes] 需要方框标记的点下标
 */
function drawLineChart(ctx, geometry, style = {}) {
  if (!ctx || !geometry || geometry.empty) return;

  const {
    lineColor = '#b23a2e',
    fillColor = 'rgba(178, 58, 46, 0.10)',
    gridColor = '#e5e7eb',
    textColor = '#9ca3af',
    font = '10px sans-serif',
    lineWidth = 2,
    labelOffset = 14,
    markedIndexes = [],
  } = style;

  const { points, grid, reference, plot } = geometry;

  ctx.clearRect(0, 0, plot.right + labelOffset + 20, plot.bottom + 20);

  // ---------- 网格与刻度值 ----------
  ctx.font = font;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const line of grid) {
    ctx.beginPath();
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.moveTo(plot.left, line.y);
    ctx.lineTo(plot.right, line.y);
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.fillText(String(Math.round(line.value)), plot.right + labelOffset, line.y);
  }

  // ---------- 参考线：入池起始分 ----------
  if (reference) {
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.moveTo(plot.left, reference.y);
    ctx.lineTo(plot.right, reference.y);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- 曲线下方的淡色填充 ----------
  if (points.length > 1) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, plot.bottom);
    for (const point of points) {
      ctx.lineTo(point.x, point.y);
    }
    ctx.lineTo(points[points.length - 1].x, plot.bottom);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
  }

  // ---------- 曲线本体 ----------
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();

  // ---------- 末点高亮：最关心的是「我现在在哪」 ----------
  const last = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(last.x, last.y, 6.5, 0, Math.PI * 2);
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.35;
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.strokeStyle = lineColor;
  for (const index of markedIndexes) {
    const point = points[index];
    if (point) ctx.strokeRect(point.x - 5, point.y - 5, 10, 10);
  }
}

module.exports = {
  MIN_RANGE,
  niceStep,
  computeChartGeometry,
  drawLineChart,
};
