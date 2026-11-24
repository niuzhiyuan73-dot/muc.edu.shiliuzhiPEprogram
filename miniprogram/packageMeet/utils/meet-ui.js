/**
 * 运动会页面的提示出口
 * ============================================================
 * 原先每个页面把 notice/error 渲染在**页面顶部**：页面一长，顶幅早就滚出
 * 视口，用户点完按钮什么都看不见——「指派成功了吗？失败了为什么？」全靠猜。
 * （试用反馈原话：所有的错误提示都在顶上，用户完全看不见。）
 *
 * 现在统一两个出口：
 *   · 失败 → `wx.showModal`（弹窗，必须点「知道了」才消失，错误不该被漏掉；
 *     晋级冲突这类长文案也只有弹窗容得下）；
 *   · 成功 → `wx.showToast`（轻量、自动消失，不打断连续操作）。
 *
 * 加载失败不归这里管：那种是「整页出不来」，页面有空态 + 重试按钮兜底。
 * ============================================================
 */

/** 失败提示：弹窗。长文案（缺哪些项目、冲突怎么改）也放得下。 */
function showError(message, title = '无法完成') {
  if (typeof wx === 'undefined' || !wx.showModal) return;
  wx.showModal({
    title,
    content: String(message || '操作失败，请稍后再试'),
    showCancel: false,
    confirmText: '知道了',
  });
}

/** 成功提示：轻 toast。 */
function showNotice(message) {
  if (typeof wx === 'undefined' || !wx.showToast) return;
  wx.showToast({ title: String(message || '已完成'), icon: 'none', duration: 3000 });
}

/** 统一反馈不依赖滚动位置；保留页面文字，方便关闭弹窗后核对。 */
function updateMeetPage(page, values) {
  if (page.unloaded) return;
  if (values.error) showError(values.error);
  else if (values.notice) showNotice(values.notice);
  for (const key of ['bulkJudges', 'bulkSessions', 'voidKeys', 'assignJudgeIds', 'assignSessionKeys']) {
    if (Array.isArray(values[key])) {
      values[`${key}Selected`] = Object.fromEntries(values[key].map(id => [id, true]));
    }
  }
  page.setData(values);
}

module.exports = { showError, showNotice, updateMeetPage };
