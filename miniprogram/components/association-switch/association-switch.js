/**
 * 协会切换器（首页与「我的」共用）
 * ============================================================
 * 一个只读的小徽章：项目名（三字）+ 一个下拉的暗示。点它弹
 * wx.showActionSheet，选中另一个协会后**抛出 change 事件**（`{ id }`），
 * 由所在页面决定怎么用。
 *
 * 【为什么只抛事件、不自己切】
 * 首页与「我的」的切换是**全局**的（切中间三个标签页的数据范围），但组件
 * 不该知道「全局协会」存在哪儿——那是 app 的职责。组件只管「用户想选哪个」，
 * 落到 app.setAssociation 由页面来做。个人详情页 / 他人主页的切换是**页面局部**
 * 的，同一个组件也照样能收进事件、由页面记在本地字段里。
 *
 * 【为什么读注册表而不接收清单】
 * 协会清单是代码注册表（utils/associations.js）里的唯一真相源，组件直接读，
 * 页面不必再把整份清单传进来再传回去。
 * ============================================================
 */

const { activeAssociations } = require('../../shared/utils/associations.js');

Component({
  properties: {
    /** 当前选中的协会 id */
    value: {
      type: String,
      value: '',
      observer(next) {
        this.refreshLabel(next);
      },
    },
    /** 视觉变体：'onbrand' 用于深色品牌区（半透明白玻璃拟态）；缺省为浅底胶囊 */
    variant: {
      type: String,
      value: '',
    },
    /**
     * 可选前缀，用来交代这个切换器改变的是什么。
     * 首页 / 我的传「默认项目」；个人详情页的项目切换是页面局部的，留空。
     */
    label: {
      type: String,
      value: '',
    },
  },

  data: {
    sportName: '',
    glyph: '',
  },

  lifetimes: {
    attached() {
      this.refreshLabel(this.data.value);
    },
  },

  methods: {
    /** 按 id 取协会，刷新徽章上的项目名 */
    refreshLabel(id) {
      const list = activeAssociations();
      const found = list.find((item) => item.id === id) || list[0] || null;
      this.setData({
        sportName: found ? found.sportName : '',
        glyph: found ? found.logoGlyph || '' : '',
      });
    },

    /** 点了徽章：弹出协会清单，选中别的协会时把 id 抛给页面 */
    onTap() {
      const list = activeAssociations();
      // 只有一个协会就没有可切的，点了也没意义
      if (list.length <= 1) return;
      if (typeof wx === 'undefined' || typeof wx.showActionSheet !== 'function') return;

      wx.showActionSheet({
        itemList: list.map((item) => item.name),
        success: (res) => {
          const picked = list[res.tapIndex];
          if (!picked || picked.id === this.data.value) return;
          this.triggerEvent('change', { id: picked.id });
        },
      });
    },
  },
});
