/**
 * 学校维度的演示内容（仅用于本地模拟数据源）
 * ============================================================
 * 首页 / 排行榜 / 比赛这几页的数据本来是**跨协会聚合**的——那套数据属于民大
 * （多协会改造前唯一的那所学校），与学校无关。多校之后若切到别的学校还是这套，
 * 会让人以为「切了没反应」。这里为**模拟学校**（北航）造一份演示内容：切到北航
 * 即展示北航自己的公告、榜单、比赛与赛事，并整体处于只读浏览（不提供任何写入口）。
 *
 * 【为什么要按协会分开造】
 * 中间三个界面（排行榜 / 比赛 / 赛事）的数据范围是**当前协会**，不是整所学校。
 * 只造一个协会的内容，切了协会却纹丝不动，同样会让人以为「切了没反应」。所以
 * 北航的每一份演示内容都按协会（匹克球 / 乒乓 / 羽球 / 网球）各造一套；首页因为是
 * 跨协会聚合，就把各协会各取一条拼在一起。
 *
 * 【为什么真学校不在这里造数据】
 * 民大展示的就是应用本身的数据（聚合视图），不是演示。各 accessor 对其返回
 * null，调用方回落到真实视图——「本校看真实数据、外校看演示」这条口径才清楚。
 *
 * 【为什么是纯静态】
 * 北航是测试样本（seed 里标了 simulated），没有真实数据源。几组示例内容写在
 * 这里，免得为了假数据去动集合与协议。它不碰 wx、不碰 I/O，是纯计算模块；
 * 当前浏览的是哪所学校、哪个协会，都由调用方（页面）传入，本模块不自己读会话。
 * ============================================================
 */

const { ALL_RANK_PROJECTS, RANK_PROJECT_LABEL } = require('../shared/utils/constants.js');
const { getAssociation } = require('../shared/utils/associations.js');

/** 榜单标题里的名字，与 rank-view 保持一致 */
const BOARD_LABEL = '等级分榜';
/** 榜单最多展示多少名，与 rank-view 保持一致 */
const TOP_LIMIT = 10;
/** 前三名的奖牌样式 */
const MEDALS = ['gold', 'silver', 'bronze'];

/**
 * 模拟学校的演示数据。
 * key 是 schoolId；只有在这里登记过的学校才会进入「外校只读浏览」的分支。
 * 每所学校下按协会 id 分桶（pkb / tt / bd / tn），每桶各有一份 home / rank / events / matches。
 *
 * rank[项目] 里的一行是「榜面字段」，rank 行/avatar/名次由 schoolRank 统一补；
 * matches 里的一行已经是 buildRecordRow 的产出口径，权限位一律置假（只读）。
 * 各条 id 都带协会前缀，免得首页把三协会聚合起来时撞 key。
 */
const DEMO_SCHOOLS = {
  buaa: {
    shortName: '北航',
    glyph: '航',

    associations: {
      /* ---------------- 匹克球 ---------------- */
      pkb: {
        home: {
          announcements: [
            { id: 'buaa_pkb_a1', title: '北航匹克球协会 2026 秋季招新', category: '招新', pinned: true, dateText: '2026-10-20',
              content: '面向全体在校生招募新会员，11 月 1 日前到体育部登记即可，欢迎零基础加入。' },
            { id: 'buaa_pkb_a2', title: '体育馆匹克球场开放时间调整', category: '通知', pinned: false, dateText: '2026-10-15',
              content: '即日起工作日 18:00–22:00 开放，周末全天开放；高峰时段请在群里预约。' },
            { id: 'buaa_pkb_a3', title: '北航匹克球校队选拔赛开始报名', category: '赛事', pinned: false, dateText: '2026-10-08',
              content: '校级代表队选拔，面向各院系好手，报名截止 10 月 30 日。' },
          ],
          events: [
            { id: 'buaa_pkb_e1', title: '北航新生杯匹克球赛', statusLabel: '报名中', isOngoing: false,
              timeText: '2026-11-05 09:00', location: '学院路校区体育馆', quotaText: '限 32 人' },
            { id: 'buaa_pkb_e2', title: '北航院系匹克球友谊赛', statusLabel: '进行中', isOngoing: true,
              timeText: '2026-10-28 14:00', location: '沙河校区球场', quotaText: '已满 16 人' },
          ],
          summary: { memberCount: 46, matchCount: 128, eventCount: 5, seasonText: '2026-09-01 — 2026-12-31' },
        },

        rank: {
          men_singles: [
            { nickName: '李昊', realName: '李昊然', record: '14 胜 2 负', elo: '1712', winRate: '88%', status: '' },
            { nickName: '陈子恒', realName: '陈子恒', record: '11 胜 4 负', elo: '1668', winRate: '73%', status: '' },
            { nickName: '王岩', realName: '王岩', record: '10 胜 5 负', elo: '1642', winRate: '67%', status: '' },
            { nickName: '赵一鸣', realName: '赵一鸣', record: '8 胜 6 负', elo: '1601', winRate: '57%', status: 'provisional' },
            { nickName: '孙睿', realName: '孙睿', record: '7 胜 7 负', elo: '1577', winRate: '50%', status: '' },
            { nickName: '周子墨', realName: '周子墨', record: '5 胜 9 负', elo: '1520', winRate: '36%', status: 'inactive' },
          ],
          women_singles: [
            { nickName: '林晓', realName: '林晓', record: '13 胜 1 负', elo: '1698', winRate: '93%', status: '' },
            { nickName: '周雨桐', realName: '周雨桐', record: '10 胜 4 负', elo: '1650', winRate: '71%', status: '' },
            { nickName: '吴桐', realName: '吴桐', record: '8 胜 5 负', elo: '1612', winRate: '62%', status: 'provisional' },
            { nickName: '许晴', realName: '许晴', record: '6 胜 8 负', elo: '1556', winRate: '43%', status: '' },
          ],
          doubles: [
            { nickName: '李昊 / 王岩', realName: '', record: '16 胜 3 负', elo: '1740', winRate: '84%', status: '' },
            { nickName: '陈子恒 / 孙睿', realName: '', record: '12 胜 5 负', elo: '1689', winRate: '71%', status: '' },
            { nickName: '林晓 / 周雨桐', realName: '', record: '9 胜 6 负', elo: '1631', winRate: '60%', status: '' },
          ],
        },

        events: {
          seasonText: '2026 秋季赛季 · 北航匹克球',
          list: [
            { id: 'buaa_pkb_e3', title: '北航匹克球校队选拔赛', pinned: true, statusLabel: '报名中', isSignup: true, isOngoing: false,
              timeText: '2026-11-18 13:30', location: '学院路校区体育馆', levelLabel: '校级', matchTypeLabel: '单打', disciplineLabel: '', quotaText: '7/24 人' },
            { id: 'buaa_pkb_e1', title: '北航新生杯匹克球赛', pinned: false, statusLabel: '报名中', isSignup: true, isOngoing: false,
              timeText: '2026-11-05 09:00', location: '学院路校区体育馆', levelLabel: '校级', matchTypeLabel: '单打', disciplineLabel: '男单', quotaText: '18/32 人' },
            { id: 'buaa_pkb_e2', title: '北航院系匹克球友谊赛', pinned: false, statusLabel: '进行中', isSignup: false, isOngoing: true,
              timeText: '2026-10-28 14:00', location: '沙河校区球场', levelLabel: '院系', matchTypeLabel: '双打', disciplineLabel: '混双', quotaText: '16/16 人' },
            { id: 'buaa_pkb_e4', title: '北航匹克球春季积分赛', pinned: false, statusLabel: '已结束', isSignup: false, isOngoing: false,
              timeText: '2026-05-20 09:00', location: '沙河校区球场', levelLabel: '校级', matchTypeLabel: '单打', disciplineLabel: '女单', quotaText: '24/24 人' },
          ],
          points: [
            { nickName: '李昊', realName: '李昊然', count: 6, points: 60 },
            { nickName: '陈子恒', realName: '陈子恒', count: 5, points: 52 },
            { nickName: '林晓', realName: '林晓', count: 5, points: 50 },
            { nickName: '王岩', realName: '王岩', count: 4, points: 38 },
            { nickName: '周雨桐', realName: '周雨桐', count: 3, points: 30 },
            { nickName: '孙睿', realName: '孙睿', count: 3, points: 26 },
            { nickName: '吴桐', realName: '吴桐', count: 2, points: 18 },
          ],
        },

        matches: [
          { matchId: 'buaa_pkb_m1', typeLabel: '男单', formatText: '11 分制 · 三局两胜', dateText: '2026-10-12 19:30',
            locationText: '学院路体育馆 3 号场', teamAText: '李昊', teamBText: '王岩', winnerSide: 'A',
            scoreText: '11:7 11:9', statusLabel: '已生效', statusClass: 'is-active' },
          { matchId: 'buaa_pkb_m2', typeLabel: '女单', formatText: '11 分制 · 三局两胜', dateText: '2026-10-12 20:10',
            locationText: '学院路体育馆 3 号场', teamAText: '林晓', teamBText: '周雨桐', winnerSide: 'A',
            scoreText: '9:11 11:6 11:8', statusLabel: '已生效', statusClass: 'is-active' },
          { matchId: 'buaa_pkb_m3', typeLabel: '双打', formatText: '11 分制 · 三局两胜', dateText: '2026-10-10 18:00',
            locationText: '沙河校区球场', teamAText: '李昊、王岩', teamBText: '陈子恒、孙睿', winnerSide: 'B',
            scoreText: '11:13 9:11', statusLabel: '已生效', statusClass: 'is-active' },
          { matchId: 'buaa_pkb_m4', typeLabel: '男单', formatText: '11 分制 · 三局两胜', dateText: '2026-10-08 19:00',
            locationText: '学院路体育馆 1 号场', teamAText: '赵一鸣', teamBText: '孙睿', winnerSide: '',
            scoreText: '', statusLabel: '待确认', statusClass: 'is-pending' },
        ],
      },

      /* ---------------- 乒乓球 ---------------- */
      tt: {
        home: {
          announcements: [
            { id: 'buaa_tt_a1', title: '北航乒乓球协会 2026 秋季招新', category: '招新', pinned: true, dateText: '2026-10-22',
              content: '面向全体在校生招募新会员，11 月 3 日前到体育部登记，欢迎零基础加入。' },
            { id: 'buaa_tt_a2', title: '乒乓球馆新添发球机，欢迎体验', category: '通知', pinned: false, dateText: '2026-10-16',
              content: '训练馆新增两台发球机，工作日 17:00 后开放自助练习。' },
            { id: 'buaa_tt_a3', title: '北航乒乓球院系联赛报名开始', category: '赛事', pinned: false, dateText: '2026-10-10',
              content: '以院系为单位组队报名，每队 4–6 人，报名截止 11 月 8 日。' },
          ],
          events: [
            { id: 'buaa_tt_e1', title: '北航乒乓球新生杯', statusLabel: '报名中', isOngoing: false,
              timeText: '2026-11-08 09:00', location: '沙河校区乒乓球馆', quotaText: '限 24 人' },
            { id: 'buaa_tt_e2', title: '北航乒乓球院系联赛', statusLabel: '进行中', isOngoing: true,
              timeText: '2026-10-30 18:00', location: '学院路校区乒乓球馆', quotaText: '已满 12 队' },
          ],
          summary: { memberCount: 46, matchCount: 96, eventCount: 4, seasonText: '2026-09-01 — 2026-12-31' },
        },

        rank: {
          men_singles: [
            { nickName: '张锐', realName: '张锐', record: '13 胜 2 负', elo: '1705', winRate: '87%', status: '' },
            { nickName: '刘洋', realName: '刘洋', record: '11 胜 4 负', elo: '1660', winRate: '73%', status: '' },
            { nickName: '郑好', realName: '郑好', record: '9 胜 5 负', elo: '1633', winRate: '64%', status: '' },
            { nickName: '冯磊', realName: '冯磊', record: '7 胜 7 负', elo: '1585', winRate: '50%', status: 'provisional' },
            { nickName: '邓超', realName: '邓超', record: '5 胜 9 负', elo: '1540', winRate: '36%', status: 'inactive' },
          ],
          women_singles: [
            { nickName: '苏晴', realName: '苏晴', record: '12 胜 2 负', elo: '1688', winRate: '86%', status: '' },
            { nickName: '白露', realName: '白露', record: '9 胜 5 负', elo: '1625', winRate: '64%', status: '' },
            { nickName: '顾佳', realName: '顾佳', record: '7 胜 6 负', elo: '1590', winRate: '54%', status: 'provisional' },
          ],
          doubles: [
            { nickName: '张锐 / 刘洋', realName: '', record: '15 胜 4 负', elo: '1725', winRate: '79%', status: '' },
            { nickName: '苏晴 / 白露', realName: '', record: '10 胜 5 负', elo: '1660', winRate: '67%', status: '' },
          ],
        },

        events: {
          seasonText: '2026 秋季赛季 · 北航乒乓',
          list: [
            { id: 'buaa_tt_e3', title: '北航乒乓球院系联赛', pinned: true, statusLabel: '报名中', isSignup: true, isOngoing: false,
              timeText: '2026-11-12 18:30', location: '学院路校区乒乓球馆', levelLabel: '院系', matchTypeLabel: '团体', disciplineLabel: '', quotaText: '9/16 队' },
            { id: 'buaa_tt_e1', title: '北航乒乓球新生杯', pinned: false, statusLabel: '报名中', isSignup: true, isOngoing: false,
              timeText: '2026-11-08 09:00', location: '沙河校区乒乓球馆', levelLabel: '校级', matchTypeLabel: '单打', disciplineLabel: '男单', quotaText: '14/24 人' },
            { id: 'buaa_tt_e2', title: '北航乒乓球院系联赛（小组赛）', pinned: false, statusLabel: '进行中', isSignup: false, isOngoing: true,
              timeText: '2026-10-30 18:00', location: '学院路校区乒乓球馆', levelLabel: '院系', matchTypeLabel: '团体', disciplineLabel: '混团', quotaText: '12/12 队' },
            { id: 'buaa_tt_e4', title: '北航乒乓球春季积分赛', pinned: false, statusLabel: '已结束', isSignup: false, isOngoing: false,
              timeText: '2026-05-18 09:00', location: '沙河校区乒乓球馆', levelLabel: '校级', matchTypeLabel: '单打', disciplineLabel: '女单', quotaText: '20/20 人' },
          ],
          points: [
            { nickName: '张锐', realName: '张锐', count: 6, points: 58 },
            { nickName: '苏晴', realName: '苏晴', count: 5, points: 50 },
            { nickName: '刘洋', realName: '刘洋', count: 5, points: 46 },
            { nickName: '白露', realName: '白露', count: 4, points: 36 },
            { nickName: '郑好', realName: '郑好', count: 3, points: 28 },
            { nickName: '顾佳', realName: '顾佳', count: 2, points: 20 },
          ],
        },

        matches: [
          { matchId: 'buaa_tt_m1', typeLabel: '男单', formatText: '11 分制 · 三局两胜', dateText: '2026-10-13 19:00',
            locationText: '学院路乒乓球馆 2 号台', teamAText: '张锐', teamBText: '刘洋', winnerSide: 'A',
            scoreText: '11:8 11:9', statusLabel: '已生效', statusClass: 'is-active' },
          { matchId: 'buaa_tt_m2', typeLabel: '女单', formatText: '11 分制 · 三局两胜', dateText: '2026-10-13 19:40',
            locationText: '学院路乒乓球馆 2 号台', teamAText: '苏晴', teamBText: '白露', winnerSide: 'A',
            scoreText: '11:6 9:11 11:7', statusLabel: '已生效', statusClass: 'is-active' },
          { matchId: 'buaa_tt_m3', typeLabel: '双打', formatText: '11 分制 · 三局两胜', dateText: '2026-10-11 18:00',
            locationText: '沙河乒乓球馆 1 号台', teamAText: '张锐、刘洋', teamBText: '郑好、冯磊', winnerSide: 'B',
            scoreText: '9:11 11:13', statusLabel: '已生效', statusClass: 'is-active' },
          { matchId: 'buaa_tt_m4', typeLabel: '男单', formatText: '11 分制 · 三局两胜', dateText: '2026-10-09 19:00',
            locationText: '沙河乒乓球馆 1 号台', teamAText: '冯磊', teamBText: '邓超', winnerSide: '',
            scoreText: '', statusLabel: '待确认', statusClass: 'is-pending' },
        ],
      },

      /* ---------------- 羽毛球 ---------------- */
      bd: {
        home: {
          announcements: [
            { id: 'buaa_bd_a1', title: '北航羽毛球协会 2026 秋季招新', category: '招新', pinned: true, dateText: '2026-10-19',
              content: '面向全体在校生招募新会员，11 月 2 日前到体育部登记，需要自备球拍。' },
            { id: 'buaa_bd_a2', title: '羽毛球场地预约规则更新', category: '通知', pinned: false, dateText: '2026-10-12',
              content: '即日起每周一开放下一周场地预约，每人每次最多约两小时。' },
            { id: 'buaa_bd_a3', title: '北航羽毛球公开赛报名开始', category: '赛事', pinned: false, dateText: '2026-10-06',
              content: '面向全校的单项公开赛，分男单、女单、双打，报名截止 11 月 12 日。' },
          ],
          events: [
            { id: 'buaa_bd_e1', title: '北航羽毛球新生杯', statusLabel: '报名中', isOngoing: false,
              timeText: '2026-11-02 09:00', location: '学院路校区羽毛球馆', quotaText: '限 40 人' },
            { id: 'buaa_bd_e2', title: '北航院系羽毛球团体赛', statusLabel: '进行中', isOngoing: true,
              timeText: '2026-10-26 14:00', location: '沙河校区羽毛球馆', quotaText: '已满 8 队' },
          ],
          summary: { memberCount: 46, matchCount: 110, eventCount: 6, seasonText: '2026-09-01 — 2026-12-31' },
        },

        rank: {
          men_singles: [
            { nickName: '何俊', realName: '何俊', record: '15 胜 1 负', elo: '1720', winRate: '94%', status: '' },
            { nickName: '高远', realName: '高远', record: '12 胜 3 负', elo: '1675', winRate: '80%', status: '' },
            { nickName: '罗宇', realName: '罗宇', record: '9 胜 6 负', elo: '1620', winRate: '60%', status: '' },
            { nickName: '谢飞', realName: '谢飞', record: '6 胜 8 负', elo: '1560', winRate: '43%', status: 'provisional' },
          ],
          women_singles: [
            { nickName: '林悦', realName: '林悦', record: '14 胜 1 负', elo: '1702', winRate: '93%', status: '' },
            { nickName: '邱雅', realName: '邱雅', record: '10 胜 4 负', elo: '1640', winRate: '71%', status: '' },
            { nickName: '唐宁', realName: '唐宁', record: '7 胜 6 负', elo: '1585', winRate: '54%', status: 'inactive' },
          ],
          doubles: [
            { nickName: '何俊 / 高远', realName: '', record: '17 胜 2 负', elo: '1755', winRate: '89%', status: '' },
            { nickName: '林悦 / 邱雅', realName: '', record: '11 胜 5 负', elo: '1665', winRate: '69%', status: '' },
          ],
        },

        events: {
          seasonText: '2026 秋季赛季 · 北航羽球',
          list: [
            { id: 'buaa_bd_e3', title: '北航羽毛球公开赛', pinned: true, statusLabel: '报名中', isSignup: true, isOngoing: false,
              timeText: '2026-11-16 13:30', location: '学院路校区羽毛球馆', levelLabel: '校级', matchTypeLabel: '单打', disciplineLabel: '', quotaText: '11/32 人' },
            { id: 'buaa_bd_e1', title: '北航羽毛球新生杯', pinned: false, statusLabel: '报名中', isSignup: true, isOngoing: false,
              timeText: '2026-11-02 09:00', location: '学院路校区羽毛球馆', levelLabel: '校级', matchTypeLabel: '单打', disciplineLabel: '男单', quotaText: '26/40 人' },
            { id: 'buaa_bd_e2', title: '北航院系羽毛球团体赛', pinned: false, statusLabel: '进行中', isSignup: false, isOngoing: true,
              timeText: '2026-10-26 14:00', location: '沙河校区羽毛球馆', levelLabel: '院系', matchTypeLabel: '双打', disciplineLabel: '混双', quotaText: '8/8 队' },
            { id: 'buaa_bd_e4', title: '北航羽毛球春季积分赛', pinned: false, statusLabel: '已结束', isSignup: false, isOngoing: false,
              timeText: '2026-05-16 09:00', location: '沙河校区羽毛球馆', levelLabel: '校级', matchTypeLabel: '单打', disciplineLabel: '女单', quotaText: '28/28 人' },
          ],
          points: [
            { nickName: '何俊', realName: '何俊', count: 6, points: 62 },
            { nickName: '林悦', realName: '林悦', count: 5, points: 54 },
            { nickName: '高远', realName: '高远', count: 5, points: 48 },
            { nickName: '邱雅', realName: '邱雅', count: 4, points: 40 },
            { nickName: '罗宇', realName: '罗宇', count: 3, points: 30 },
          ],
        },

        matches: [
          { matchId: 'buaa_bd_m1', typeLabel: '男单', formatText: '21 分制 · 三局两胜', dateText: '2026-10-11 19:00',
            locationText: '学院路羽毛球馆 4 号场', teamAText: '何俊', teamBText: '高远', winnerSide: 'A',
            scoreText: '21:15 21:18', statusLabel: '已生效', statusClass: 'is-active' },
          { matchId: 'buaa_bd_m2', typeLabel: '女单', formatText: '21 分制 · 三局两胜', dateText: '2026-10-11 20:00',
            locationText: '学院路羽毛球馆 4 号场', teamAText: '林悦', teamBText: '邱雅', winnerSide: 'A',
            scoreText: '21:12 19:21 21:16', statusLabel: '已生效', statusClass: 'is-active' },
          { matchId: 'buaa_bd_m3', typeLabel: '双打', formatText: '21 分制 · 三局两胜', dateText: '2026-10-09 18:30',
            locationText: '沙河羽毛球馆 2 号场', teamAText: '何俊、高远', teamBText: '罗宇、谢飞', winnerSide: 'B',
            scoreText: '18:21 21:19 16:21', statusLabel: '已生效', statusClass: 'is-active' },
          { matchId: 'buaa_bd_m4', typeLabel: '男单', formatText: '21 分制 · 三局两胜', dateText: '2026-10-07 19:00',
            locationText: '沙河羽毛球馆 2 号场', teamAText: '谢飞', teamBText: '罗宇', winnerSide: '',
            scoreText: '', statusLabel: '待确认', statusClass: 'is-pending' },
        ],
      },

      /* ---------------- 网球 ---------------- */
      tn: {
        home: {
          announcements: [
            { id: 'buaa_tn_a1', title: '北航网球协会 2026 秋季招新', category: '招新', pinned: true, dateText: '2026-10-21',
              content: '面向全体在校生招募新会员，10 月 31 日前到体育部登记，场地与用球由协会统一安排。' },
            { id: 'buaa_tn_a2', title: '学院路网球场夜间开放时段调整', category: '通知', pinned: false, dateText: '2026-10-14',
              content: '即日起 1、2 号场 18:00–22:00 开放夜间灯光，需提前一天在协会群预约。' },
            { id: 'buaa_tn_a3', title: '北航网球公开赛报名开始', category: '赛事', pinned: false, dateText: '2026-10-09',
              content: '设男单、女单、双打三个项目，报名截止 11 月 8 日，限本校在册会员。' },
          ],
          events: [
            { id: 'buaa_tn_e1', title: '北航网球新生杯', statusLabel: '报名中', isOngoing: false,
              timeText: '2026-11-08 09:00', location: '学院路校区网球场', quotaText: '限 32 人' },
            { id: 'buaa_tn_e2', title: '北航院系网球团体赛', statusLabel: '进行中', isOngoing: true,
              timeText: '2026-10-25 14:00', location: '沙河校区网球场', quotaText: '已满 8 队' },
          ],
          summary: { memberCount: 38, matchCount: 96, eventCount: 4, seasonText: '2026-09-01 — 2026-12-31' },
        },

        rank: {
          men_singles: [
            { nickName: '郑凯', realName: '郑凯', record: '13 胜 2 负', elo: '1688', winRate: '87%', status: '' },
            { nickName: '徐天成', realName: '徐天成', record: '10 胜 4 负', elo: '1645', winRate: '71%', status: '' },
            { nickName: '马骁', realName: '马骁', record: '9 胜 5 负', elo: '1602', winRate: '64%', status: '' },
            { nickName: '江帆', realName: '江帆', record: '7 胜 6 负', elo: '1566', winRate: '54%', status: 'provisional' },
            { nickName: '崔浩', realName: '崔浩', record: '4 胜 9 负', elo: '1521', winRate: '31%', status: 'inactive' },
          ],
          women_singles: [
            { nickName: '苏念', realName: '苏念', record: '12 胜 1 负', elo: '1692', winRate: '92%', status: '' },
            { nickName: '白露', realName: '白露', record: '9 胜 3 负', elo: '1638', winRate: '75%', status: '' },
            { nickName: '韩雨', realName: '韩雨', record: '6 胜 7 负', elo: '1580', winRate: '46%', status: '' },
            { nickName: '谭晶', realName: '谭晶', record: '3 胜 5 负', elo: '1542', winRate: '38%', status: 'provisional' },
          ],
          doubles: [
            { nickName: '郑凯 / 徐天成', realName: '', record: '15 胜 2 负', elo: '1725', winRate: '88%', status: '' },
            { nickName: '苏念 / 白露', realName: '', record: '10 胜 5 负', elo: '1658', winRate: '67%', status: '' },
            { nickName: '马骁 / 江帆', realName: '', record: '7 胜 7 负', elo: '1596', winRate: '50%', status: 'inactive' },
          ],
        },

        events: {
          seasonText: '2026 秋季赛季 · 北航网球',
          list: [
            { id: 'buaa_tn_e3', title: '北航网球公开赛', pinned: true, statusLabel: '报名中', isSignup: true, isOngoing: false,
              timeText: '2026-11-20 13:30', location: '学院路校区网球场', levelLabel: '校级', matchTypeLabel: '单打', disciplineLabel: '', quotaText: '9/32 人' },
            { id: 'buaa_tn_e1', title: '北航网球新生杯', pinned: false, statusLabel: '报名中', isSignup: true, isOngoing: false,
              timeText: '2026-11-08 09:00', location: '学院路校区网球场', levelLabel: '校级', matchTypeLabel: '单打', disciplineLabel: '男单', quotaText: '21/32 人' },
            { id: 'buaa_tn_e2', title: '北航院系网球团体赛', pinned: false, statusLabel: '进行中', isSignup: false, isOngoing: true,
              timeText: '2026-10-25 14:00', location: '沙河校区网球场', levelLabel: '院系', matchTypeLabel: '双打', disciplineLabel: '混双', quotaText: '8/8 队' },
            { id: 'buaa_tn_e4', title: '北航网球春季积分赛', pinned: false, statusLabel: '已结束', isSignup: false, isOngoing: false,
              timeText: '2026-05-18 09:00', location: '沙河校区网球场', levelLabel: '校级', matchTypeLabel: '单打', disciplineLabel: '女单', quotaText: '24/24 人' },
          ],
          points: [
            { nickName: '郑凯', realName: '郑凯', count: 6, points: 58 },
            { nickName: '苏念', realName: '苏念', count: 5, points: 50 },
            { nickName: '徐天成', realName: '徐天成', count: 4, points: 42 },
            { nickName: '白露', realName: '白露', count: 4, points: 36 },
            { nickName: '马骁', realName: '马骁', count: 3, points: 28 },
          ],
        },

        matches: [
          { matchId: 'buaa_tn_m1', typeLabel: '男单', formatText: '一盘决胜 · 每盘 6 局（6:6 抢七）', dateText: '2026-10-13 18:30',
            locationText: '学院路网球场 1 号场', teamAText: '郑凯', teamBText: '徐天成', winnerSide: 'A',
            scoreText: '6:4 7:5', statusLabel: '已生效', statusClass: 'is-active' },
          { matchId: 'buaa_tn_m2', typeLabel: '女单', formatText: '三盘两胜 · 每盘 6 局（6:6 抢七）', dateText: '2026-10-13 19:20',
            locationText: '学院路网球场 1 号场', teamAText: '苏念', teamBText: '白露', winnerSide: 'A',
            scoreText: '6:3 4:6 7:6(5)', statusLabel: '已生效', statusClass: 'is-active' },
          { matchId: 'buaa_tn_m3', typeLabel: '双打', formatText: '一盘决胜 · 每盘 4 局短盘（4:4 抢七）', dateText: '2026-10-10 18:00',
            locationText: '沙河网球场 2 号场', teamAText: '郑凯、徐天成', teamBText: '马骁、江帆', winnerSide: 'B',
            scoreText: '3:5', statusLabel: '已生效', statusClass: 'is-active' },
          { matchId: 'buaa_tn_m4', typeLabel: '男单', formatText: '一盘决胜 · 每盘 6 局（6:6 抢七）', dateText: '2026-10-08 19:00',
            locationText: '沙河网球场 2 号场', teamAText: '江帆', teamBText: '崔浩', winnerSide: '',
            scoreText: '', statusLabel: '待确认', statusClass: 'is-pending' },
        ],
      },
    },
  },
};

/** 状态 → 徽章文案，与 rank-view.badgeOf 同口径 */
function badgeText(status) {
  if (status === 'provisional') return '定级中';
  if (status === 'inactive') return '不活跃';
  return '';
}

/** 昵称首字占位头像 */
function avatarOf(nickName) {
  return (nickName || '?').slice(0, 1);
}

/**
 * 演示内容的协会元信息：首页角标与提示文案共用。
 * 名称取「学校简称 + 项目名」（如「北航匹克球」），与真实协会的简称体例一致；
 * 图标字取注册表里的文字徽标，免得两处各写一份、慢慢对不上。
 *
 * @param {Object} school
 * @param {string} associationId
 * @returns {{id: string, name: string, glyph: string}}
 */
function associationMetaOf(school, associationId) {
  const assoc = getAssociation(associationId);
  return {
    id: associationId,
    name: `${school.shortName}${assoc.sportName}`,
    glyph: assoc.logoGlyph,
  };
}

/**
 * 演示学校的简称（如「北航」），供只读提示条文案使用。
 * 没有演示内容的学校返回空串。
 *
 * @param {string} schoolId
 * @returns {string}
 */
function schoolShortName(schoolId) {
  const school = DEMO_SCHOOLS[schoolId];
  return school ? school.shortName : '';
}

/**
 * 演示学校有哪些协会，供「协会」页列出该校可逛的协会。
 * 名称取「学校简称 + 项目名」（如「北航匹克球」），与首页角标同一体例；
 * 没有演示内容的学校返回 null，调用方回落到协会注册表。
 *
 * @param {string} schoolId
 * @returns {Array<{id: string, name: string, glyph: string, sportName: string}>|null}
 */
function schoolAssociations(schoolId) {
  const school = DEMO_SCHOOLS[schoolId];
  if (!school || !school.associations) return null;
  return Object.keys(school.associations).map((id) => {
    const assoc = getAssociation(id);
    return {
      id,
      name: `${school.shortName}${assoc.sportName}`,
      glyph: assoc.logoGlyph,
      sportName: assoc.sportName,
    };
  });
}

/**
 * 取某校某协会的演示内容。
 * 没有演示内容的学校返回 null（调用方回落到真实视图）；协会未登记时退回第一个，
 * 免得新加协会却还没造演示时直接空白。
 *
 * @param {string} schoolId
 * @param {string} [association]
 * @returns {{school: Object, associationId: string, meta: Object, data: Object}|null}
 */
function resolveDemo(schoolId, association) {
  const school = DEMO_SCHOOLS[schoolId];
  if (!school || !school.associations) return null;
  const ids = Object.keys(school.associations);
  if (ids.length === 0) return null;
  const associationId = ids.includes(association) ? association : ids[0];
  return {
    school,
    associationId,
    meta: associationMetaOf(school, associationId),
    data: school.associations[associationId],
  };
}

/** 演示学校里的一行榜面数据 → 页面渲染行 */
function rankRowOf(schoolId, associationId, project, entry, index) {
  const rank = index + 1;
  return {
    // 演示选手没有真实账号，编号只用于 wx:key，点了不跳转（页面会拦住）
    userId: `demo_${schoolId}_${associationId}_${project}_${rank}`,
    rank,
    medal: MEDALS[rank - 1] || '',
    isMe: false,
    nickName: entry.nickName,
    realName: entry.realName || '',
    avatarText: avatarOf(entry.nickName),
    avatarUrl: '',
    detailText: entry.record,
    valueText: String(entry.elo),
    valueClass: '',
    noteText: `胜率 ${entry.winRate}`,
    badge: badgeText(entry.status),
  };
}

/**
 * 取某校首页的演示视图。首页是跨协会聚合的，所以这里把三个协会各取一条
 * （一条公告、一场近期赛事）拼在一起，每条标注它属于哪个协会——与真实首页
 * 同一口径：内容不随「当前协会」变，但看得出有哪些协会。
 * 没有演示内容的学校返回 null，由调用方回落到聚合视图。
 *
 * @param {string} schoolId
 * @returns {{loggedIn: boolean, announcements: Object, upcomingEvents: Array, summary: Object}|null}
 */
function schoolHome(schoolId) {
  const school = DEMO_SCHOOLS[schoolId];
  if (!school || !school.associations) return null;

  const announcements = [];
  const upcomingEvents = [];
  let memberCount = 0;
  let matchCount = 0;
  let eventCount = 0;
  let seasonText = '';

  Object.keys(school.associations).forEach((associationId, index) => {
    const meta = associationMetaOf(school, associationId);
    const feed = school.associations[associationId].home || {};
    const chip = { association: meta.id, associationName: meta.name, associationGlyph: meta.glyph };

    const [headline] = feed.announcements || [];
    if (headline) announcements.push({ ...headline, ...chip });
    const [nextEvent] = feed.events || [];
    if (nextEvent) upcomingEvents.push({ ...nextEvent, ...chip, signedUp: false });

    // 会员是全局的（人人都在全部协会），故只取一份、不能相加；比赛与赛事各协会各算。
    const summary = feed.summary || {};
    if (index === 0) {
      memberCount = summary.memberCount || 0;
      seasonText = summary.seasonText || '';
    }
    matchCount += summary.matchCount || 0;
    eventCount += summary.eventCount || 0;
  });

  return {
    // loggedIn 只是占位，由调用方按当前登录态覆盖
    loggedIn: true,
    announcements: { rows: announcements, total: announcements.length, hasMore: false },
    upcomingEvents,
    summary: { memberCount, matchCount, eventCount, seasonText },
  };
}

/**
 * 取某校某协会的排行榜演示视图。形状与 rank-view.loadRankView 一致，但没有「我」
 * ——浏览者不是该校会员，me 恒为 null，页面据此出只读口径。
 *
 * @param {string} schoolId
 * @param {Object} [options]
 * @param {string} [options.project] 榜单项目，非法或未传时退回第一个项目
 * @param {string} [options.association] 当前协会，未传或未登记时退回第一个
 * @returns {Object|null}
 */
function schoolRank(schoolId, options = {}) {
  const resolved = resolveDemo(schoolId, options.association);
  if (!resolved || !resolved.data.rank) return null;

  const { school, associationId, meta, data } = resolved;
  const activeProject = ALL_RANK_PROJECTS.includes(options.project) ? options.project : ALL_RANK_PROJECTS[0];
  const fullBoard = (data.rank[activeProject] || []).map((entry, index) =>
    rankRowOf(schoolId, associationId, activeProject, entry, index)
  );
  const rows = fullBoard.slice(0, TOP_LIMIT);
  const total = fullBoard.length;

  return {
    schoolName: school.shortName,
    projectTabs: ALL_RANK_PROJECTS.map((project) => ({
      project,
      label: RANK_PROJECT_LABEL[project],
      active: project === activeProject,
    })),
    activeProject,
    activeProjectLabel: RANK_PROJECT_LABEL[activeProject],
    activeBoardLabel: BOARD_LABEL,
    rows,
    allRows: fullBoard,
    total,
    hasMore: total > rows.length,
    empty: rows.length === 0,
    playerCountText: total > TOP_LIMIT ? `前 ${TOP_LIMIT} 名 · 共 ${total} 人` : `${total} 人上榜`,
    emptyNote: rows.length === 0 ? '这个项目还没有人打过' : '',
    me: null,
    meHint: `${meta.name}的榜单仅作演示浏览`,
  };
}

/**
 * 演示比赛行：在演示数据之上补齐 buildRecordRow 那套字段，权限位一律置假，
 * 于是页面上不会出现任何「确认 / 撤销 / 录分 / 指派」入口。
 */
function matchRowOf(school, entry) {
  const asList = (text) => (text ? text.split('、').map((name, i) => ({ userId: `demo_${i}_${name}`, nickName: name })) : []);
  return {
    matchId: entry.matchId,
    typeLabel: entry.typeLabel,
    formatText: entry.formatText,
    dateText: entry.dateText,
    locationText: entry.locationText,
    courtText: '',
    teamAText: entry.teamAText,
    teamBText: entry.teamBText,
    teamAList: asList(entry.teamAText),
    teamBList: asList(entry.teamBText),
    winnerSide: entry.winnerSide,
    scoreText: entry.scoreText,
    live: null,
    liveActive: false,
    isMine: false,
    isWin: false,
    resultText: '',
    isEvent: true,
    status: entry.status,
    statusLabel: entry.statusLabel,
    statusClass: entry.statusClass,
    statusReason: '',
    action: '',
    // 只读：所有写入口一律关闭
    canConfirm: false,
    confirmRelaxed: false,
    needsScore: false,
    canRecord: false,
    canForfeit: false,
    hasReferee: false,
    referee: '',
    refereeName: '',
    refereeIsParticipant: false,
    refereeNotice: '',
    canAssignReferee: false,
  };
}

/**
 * 取某校某协会的比赛页演示视图。形状与 match-view.loadMatchView 一致：只有一排
 * 「全部比赛」标签（浏览者不是该校会员，没有「我的比赛」可言），且全部只读。
 *
 * @param {string} schoolId
 * @param {Object} [options]
 * @param {string} [options.association] 当前协会，未传或未登记时退回第一个
 * @param {boolean} [options.loggedIn] 浏览者是否已登录，仅用于视角提示
 * @returns {Object|null}
 */
function schoolMatches(schoolId, options = {}) {
  const resolved = resolveDemo(schoolId, options.association);
  if (!resolved || !resolved.data.matches) return null;

  const { school, meta, data } = resolved;
  const records = data.matches.map((entry) => matchRowOf(school, entry));
  return {
    schoolName: school.shortName,
    found: true,
    readOnly: true,
    viewer: { userId: '', roleLabel: '访客', loggedIn: Boolean(options.loggedIn) },
    tabs: [{ tab: 'mine', label: '全部比赛', active: true }],
    activeTab: 'mine',
    records,
    total: records.length,
    hasMore: false,
    emptyText: '',
    needLogin: false,
    pendingCount: 0,
    demoNotice: `${meta.name}的比赛记录仅作演示浏览，不能在这里确认或撤销`,
  };
}

/** 演示积分榜的一行榜面数据 → 页面渲染行 */
function pointRowOf(schoolId, associationId, entry, index) {
  const rank = index + 1;
  return {
    userId: `demo_${schoolId}_${associationId}_points_${rank}`,
    rank,
    medal: MEDALS[rank - 1] || '',
    isMe: false,
    nickName: entry.nickName,
    realName: entry.realName || '',
    avatarText: avatarOf(entry.nickName),
    avatarUrl: '',
    detailText: `${entry.count} 场赛事`,
    valueText: String(entry.points),
    noteText: '赛季积分',
  };
}

/**
 * 取某校某协会的赛事页演示视图。形状与 events-view.loadEventsView 一致，只读了
 * 写入口：没有发布权、没有学院赛，赛事列表与积分榜都不覆盖「我」。
 *
 * @param {string} schoolId
 * @param {Object} [options]
 * @param {string} [options.association] 当前协会，未传或未登记时退回第一个
 * @returns {Object|null}
 */
function schoolEvents(schoolId, options = {}) {
  const resolved = resolveDemo(schoolId, options.association);
  if (!resolved || !resolved.data.events) return null;

  const { school, associationId, meta, data } = resolved;
  const feed = data.events;
  const fullBoard = feed.points.map((entry, index) => pointRowOf(schoolId, associationId, entry, index));
  const rows = fullBoard.slice(0, TOP_LIMIT);
  const total = fullBoard.length;

  const events = feed.list.map((entry) => ({
    ...entry,
    signedUp: false,
    mySignupLabel: '',
    // 置顶是写操作，演示里一律不给
    canPin: false,
  }));

  return {
    schoolName: school.shortName,
    seasonText: feed.seasonText,
    rows,
    allRows: fullBoard,
    total,
    hasMore: total > rows.length,
    playerCountText: total > TOP_LIMIT ? `前 ${TOP_LIMIT} 名 · 共 ${total} 人` : `${total} 人上榜`,
    empty: rows.length === 0,
    emptyNote: '',
    me: null,
    meHint: `${meta.name}的积分榜仅作演示浏览`,
    events,
    hasEvents: events.length > 0,
    eventsEmptyNote: '还没有赛事',
    eventTotal: events.length,
    hasMoreEvents: false,
    canPublish: false,
    collegeEvents: [],
    hasCollegeEvents: false,
    collegeEventsEmptyNote: '还没有学院赛',
    collegeEventTotal: 0,
    hasMoreCollegeEvents: false,
    canManageCollege: false,
  };
}

module.exports = {
  schoolShortName,
  schoolAssociations,
  schoolHome,
  schoolRank,
  schoolMatches,
  schoolEvents,
};
