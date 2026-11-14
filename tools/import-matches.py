#!/usr/bin/env python3
"""
把俱乐部的历史成绩表导入成小程序能直接用的比赛流水。

用法
====
    python tools/import-matches.py <输入.xlsx> <输出.json> [选项]

选项
----
    --members <对照.json>     会员对照表，格式 {"学号": "userId"}。
                              不给时读输入文件里的「会员对照」工作表。
    --report <报告.xlsx>      把有问题的行写成一张表，便于逐条修。
    --season-start YYYY-MM-DD 赛季首场时间。给了它，早于这一天的行会被标为问题。
                              不给时不判早晚，只把算出来的最早一场打印出来供你核对。
    --template <模板.xlsx>    不导入，只生成一份空白模板（含示例行与填写说明）。

设计要点
========
1. **胜负与池一律推导，绝不采信表格**。比分是唯一事实，winner 由逐局比分
   算出，pool 由项目类型算出。表格里就算写了「胜方：B」，也不影响输出。
2. **宁可拦下来，也不导入半条可疑记录**。一行只要有一处问题就整行进报告，
   不写入 JSON。等级分是零和的，一条错记录会让至少两个人的分数一起错，
   而且事后极难发现。
3. **_id 用内容哈希**，与云端 cloudfunctions/data/src/core/idempotency.js 的
   matchNaturalKey 完全一致。这样同一张表导入两次不会产生两份记录，而
   且同一条比赛日后经小程序录入时也能撞上同一个 _id。两者是否仍然一致，
   由 tests/importer-contract.test.js 逐条比对守着。
4. 退出码恒为 0（只要文件读得进来）。「有问题的行」是正常结果而不是失败，
   把退出码当判据会让脚本里一条 `&&` 就中断整个流程；有问题请看报告。

依赖 openpyxl。
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone, timedelta
from decimal import Decimal, InvalidOperation

try:
    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
except ImportError:  # pragma: no cover - 只在没装依赖时走到
    sys.stderr.write("缺少依赖 openpyxl，请先执行：pip install openpyxl\n")
    sys.exit(1)


# ============================================================
# 与小程序共用的口径
# ============================================================
# 这几个常量必须与 miniprogram/utils/{constants,match-format}.js 保持一致。
# 本工具是独立进程（Python 读不了 JS），所以只能各写一份；一致性由
# tests/importer-contract.test.js 用真实的 JS 校验器逐条复查。

SHEET_MATCHES = "比赛记录"
SHEET_MEMBERS = "会员对照"

# 表头顺序即列顺序，两者永远一起改
MATCH_COLUMNS = [
    "比赛时间", "项目",
    "A队1", "A队2", "B队1", "B队2",
    "A队比分", "B队比分",
    "分制", "局制",
    "场地", "录入人", "赛事ID", "备注",
]

MEMBER_COLUMNS = ["学号", "姓名", "userId"]

MATCH_TYPE_SINGLES = 1
MATCH_TYPE_DOUBLES = 3

MATCH_TYPE_TO_POOL = {
    MATCH_TYPE_SINGLES: "singles",
    MATCH_TYPE_DOUBLES: "doubles",
}

TEAM_SIZE = {
    MATCH_TYPE_SINGLES: 1,
    MATCH_TYPE_DOUBLES: 2,
}

# 项目列接受多种写法：中文、英文、编号。表格是人手填的，宽进严出。
MATCH_TYPE_ALIASES = {
    "单打": MATCH_TYPE_SINGLES,
    "singles": MATCH_TYPE_SINGLES,
    "1": MATCH_TYPE_SINGLES,
    "双打": MATCH_TYPE_DOUBLES,
    "doubles": MATCH_TYPE_DOUBLES,
    "3": MATCH_TYPE_DOUBLES,
}

GAME_POINTS_OPTIONS = (11, 15, 21)
BEST_OF_OPTIONS = (1, 3, 5)
BEST_OF_LABEL = {1: "一局一胜", 3: "三局两胜", 5: "五局三胜"}

MATCH_STATUS_ACTIVE = 1


# ============================================================
# 单元格读取
# ============================================================

def cell_text(value):
    """把单元格读成干净的字符串。

    openpyxl 会把「20230001」这样的学号读成 int，把「20230001.0」读成 float；
    直接 str() 会得到 '20230001.0'，拿去查会员对照必然查不到。
    """
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def parse_time(value):
    """把时间单元格整理成 'YYYY-MM-DDTHH:MM:SS'。

    刻意不带时区后缀：seed.js 用的是 new Date('2026-04-08T18:00:00')，
    JS 把这种没有后缀的串按本地时间解析。带上 Z 会被当成 UTC，
    在国内会整整差 8 小时，赛季区间与「早于首场」的判定就全错了。

    @returns {(str|None, str)} 整理后的时间；看不懂时第一项为 None
    """
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%dT%H:%M:%S"), ""

    text = cell_text(value)
    if not text:
        return None, "比赛时间为空"

    # 中国人填表爱用斜杠，Excel 也会把「2026/4/8」自动转成日期；转成日期
    # 的那条上面已处理，这里兜住「被存成文本的斜杠日期」
    normalized = text.replace("/", "-").replace("年", "-").replace("月", "-").replace("日", "")
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(normalized, fmt).strftime("%Y-%m-%dT%H:%M:%S"), ""
        except ValueError:
            continue

    return None, f"看不懂的比赛时间「{text}」，建议写成 2026-04-08 18:00"


def parse_int(value):
    """读成整数；空与非法都返回 None。"""
    text = cell_text(value)
    if not text:
        return None
    try:
        number = Decimal(text)
        if not number.is_finite() or number != number.to_integral_value():
            return None
        return int(number)
    except (InvalidOperation, ValueError, OverflowError):
        return None


def parse_scores(value):
    """把「11,11」这样的逐局比分读成整数数组。

    单元格里可能混入全角逗号（中文输入法下极常见），一并容忍。

    @returns {(list|None, str)} 逐局比分；非法时第一项为 None
    """
    text = cell_text(value).replace("，", ",").replace("、", ",")
    if not text:
        return None, "比分为空"

    scores = []
    for piece in text.split(","):
        piece = piece.strip()
        if piece == "":
            return None, "比分里有空的局（逗号多写了？）"
        try:
            score = parse_int(piece)
            if score is None:
                raise ValueError()
            scores.append(score)
        except ValueError:
            return None, f"比分「{piece}」不是数字"

    if not scores:
        return None, "比分为空"
    return scores, ""


def parse_score_columns(cell_a, cell_b):
    """读取两列比分。

    两种写法都接受：
      * 分列：A队比分 = 11,11   B队比分 = 9,7
      * 合并：A队比分 = 11:9,11:7   B队比分 留空
    合并写法省一列、抄起来快，历史表格里很常见，所以两种都收。
    但两种同时出现时会读不懂——那多半是填错了，明确报出来。

    @returns {(list|None, list|None, str)} scoreA, scoreB；非法时前两项为 None
    """
    text_a = cell_text(cell_a)
    text_b = cell_text(cell_b)

    if ":" in text_a or "：" in text_a:
        if text_b:
            return None, None, "A 列写成了「11:9」形式，B 列就必须留空（两列只能填一种）"
        pairs = text_a.replace("：", ":").replace("，", ",").split(",")
        score_a, score_b = [], []
        for pair in pairs:
            pair = pair.strip()
            if ":" not in pair:
                return None, None, f"「{pair}」缺少冒号，应写成 11:9"
            left, _, right = pair.partition(":")
            try:
                a, b = parse_int(left.strip()), parse_int(right.strip())
                if a is None or b is None:
                    raise ValueError()
                score_a.append(a)
                score_b.append(b)
            except ValueError:
                return None, None, f"比分「{pair}」里不是数字"
        return score_a, score_b, ""

    score_a, error_a = parse_scores(cell_a)
    if error_a:
        return None, None, f"A 队{error_a}"
    score_b, error_b = parse_scores(cell_b)
    if error_b:
        return None, None, f"B 队{error_b}"
    return score_a, score_b, ""


# ============================================================
# 赛制与比分校验（镜像 miniprogram/utils/match-format.js）
# ============================================================

def games_to_win(best_of):
    """赢下整场需要拿下的局数。3 局需 2 胜，5 局需 3 胜，1 局需 1 胜。"""
    return (best_of + 1) // 2


def validate_game(mine, theirs, game_points, index):
    """校验单独一局，返回错误文案（合法时为空串）。

    判据只有两条：胜方分数 >= 目标分、胜方领先至少 2 分。
    绝不能写「胜方必须正好 11 分」——11 分制本来就会出现 13:11、15:13。
    """
    label = f"第 {index + 1} 局"
    if mine < 0 or theirs < 0:
        return f"{label}的比分不能是负数（{mine}:{theirs}）"
    if mine == theirs:
        return f"{label}必须分出胜负，不能打平（{mine}:{theirs}）"

    high, low = max(mine, theirs), min(mine, theirs)
    # 先判够不够分，再判分差。反过来的话「10:8」会被报成「领先不足 2 分」，
    # 而真正的问题是这局根本没打到 11 分。
    if high < game_points:
        return f"{label}没有人打到 {game_points} 分（{mine}:{theirs}）"
    if high - low < 2:
        return f"{label}胜方必须领先 2 分（{mine}:{theirs}）"
    return ""


def validate_match_score(score_a, score_b, game_points, best_of):
    """校验整场比分，顺带推出胜方。

    @returns {(list, str|None)} 错误列表；以及 'A' / 'B' / None
    """
    errors = []

    if len(score_a) == 0:
        return ["至少要录入 1 局比分"], None
    if len(score_a) != len(score_b):
        return [f"两队局数不一致（A 队 {len(score_a)} 局，B 队 {len(score_b)} 局）"], None
    if len(score_a) > best_of:
        errors.append(
            f"{BEST_OF_LABEL[best_of]}最多打 {best_of} 局，这一行录了 {len(score_a)} 局"
        )

    for index, (left, right) in enumerate(zip(score_a, score_b)):
        message = validate_game(left, right, game_points, index)
        if message:
            errors.append(message)

    games_a = sum(1 for left, right in zip(score_a, score_b) if left > right)
    games_b = sum(1 for left, right in zip(score_a, score_b) if right > left)
    need = games_to_win(best_of)

    if games_a != need and games_b != need:
        errors.append(
            f"{BEST_OF_LABEL[best_of]}需要有一方赢下 {need} 局才能结束，"
            f"这一行是 {games_a} : {games_b}"
        )
    else:
        # 已分出胜负时，决定性的那一局必须是最后一局。否则就是录多了——
        # 三局两胜录成 11:9 11:9 11:9，第三局开打前比赛其实已经结束。
        reached_a = reached_b = 0
        decisive = -1
        for index, (left, right) in enumerate(zip(score_a, score_b)):
            if left > right:
                reached_a += 1
            elif right > left:
                reached_b += 1
            if reached_a == need or reached_b == need:
                decisive = index
                break
        if decisive != len(score_a) - 1:
            extra = len(score_a) - decisive - 1
            errors.append(f"比赛在第 {decisive + 1} 局就已分出胜负，多录了 {extra} 局")

    winner = "A" if games_a > games_b else "B" if games_b > games_a else None
    return errors, winner


# ============================================================
# 自然键（镜像 cloudfunctions/data/src/core/idempotency.js）
# ============================================================

def iso_utc(match_time):
    """复刻 JS 的 new Date(本地时间).toISOString()。

    JS 输出 '2026-04-08T10:00:00.000Z'，而 Python 的 isoformat() 输出
    '...+00:00'——毫秒位与后缀都不一样，算出来的哈希自然对不上。
    这里手工拼出 JS 的那个形状，让两边的自然键逐字节相同。
    """
    moment = datetime.fromisoformat(match_time)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone(timedelta(hours=8)))
    moment = moment.astimezone(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def match_natural_key(doc):
    """比赛的自然键。队伍成员先排序，避免队友顺序不同被当成两场比赛。"""
    parts = [
        doc["pool"],
        ",".join(sorted(doc["teamA"])),
        ",".join(sorted(doc["teamB"])),
        ",".join(str(value) for value in doc["scoreA"]),
        ",".join(str(value) for value in doc["scoreB"]),
        iso_utc(doc["matchTime"]),
        doc["recorder"] or "",
    ]
    joined = "|".join(parts)
    return "m_" + hashlib.md5(joined.encode("utf-8")).hexdigest()


# ============================================================
# 会员对照
# ============================================================

def load_members(workbook, members_path):
    """读「学号 → userId」的对照关系。

    优先用 --members 指定的 JSON；没给就读输入文件里的「会员对照」工作表。
    两个来源都不存在时直接报错退出——没有对照表，学号一个都翻译不了，
    硬跑下去只会得到「满屏学号查不到」的假问题。
    """
    if members_path:
        with open(members_path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        if not isinstance(raw, dict):
            raise ValueError("会员对照 JSON 必须是一个对象：{\"学号\": \"userId\"}")
        return {str(key): str(value) for key, value in raw.items()}

    if SHEET_MEMBERS not in workbook.sheetnames:
        raise ValueError(
            f"找不到「{SHEET_MEMBERS}」工作表，也没有用 --members 指定对照表"
        )

    sheet = workbook[SHEET_MEMBERS]
    index = {name: position for position, name in enumerate(MEMBER_COLUMNS)}
    members = {}
    for row in sheet.iter_rows(min_row=2, values_only=True):
        student_id = cell_text(row[index["学号"]]) if len(row) > index["学号"] else ""
        user_id = cell_text(row[index["userId"]]) if len(row) > index["userId"] else ""
        if not student_id and not user_id:
            continue
        if not student_id or not user_id:
            continue  # 半行残缺的对照项直接跳过，不影响别的行
        members[student_id] = user_id
    return members


def resolve_member(student_id, members):
    """把学号翻成 userId。

    学号本身也当 userId 接受：表里和会员对照里写的是同一串字符时（比如
    干脆就用学号当 userId），用户不必再抄一遍对照表。
    """
    if not student_id:
        return ""
    if student_id in members:
        return members[student_id]
    return student_id


# ============================================================
# 逐行导入
# ============================================================

def read_match_rows(workbook):
    """读出「比赛记录」工作表的原始行（含行号，便于报告定位）。"""
    if SHEET_MATCHES not in workbook.sheetnames:
        raise ValueError(f"找不到「{SHEET_MATCHES}」工作表")
    sheet = workbook[SHEET_MATCHES]
    return sheet, sheet.iter_rows(min_row=2, values_only=True)


def is_skippable(columns):
    """这一行是不是「不该被当成数据」的行。

    三种：
      * Excel 在数据下面留的大片空行；
      * 表头本身（模板把表头放在说明文字下面，用户自己的表格也可能这样）；
      * 说明文字行——只在第一列有字，判据因此定为「项目、两队比分全空」，
        真正要录的一行不可能同时缺了这三样。

    少了这几条，用户每次导入都会先看到一屏与自己数据无关的报错，
    真正的问题反而被淹掉。
    """
    if all(not cell_text(value) for value in columns.values()):
        return True
    # 真实的一行不可能把「比赛时间」四个字填在时间列里，据此认出表头
    if cell_text(columns["比赛时间"]) == "比赛时间":
        return True
    return not any(
        cell_text(columns[name]) for name in ("项目", "A队比分", "B队比分")
    )


def import_row(values, members, line_number):
    """把一行表格变成一条比赛文档。

    @returns {(dict|None, list)} 文档；以及这一行的全部问题
    """
    problems = []
    columns = {}
    for index, name in enumerate(MATCH_COLUMNS):
        columns[name] = values[index] if index < len(values) else None

    if is_skippable(columns):
        return None, []

    # ---------- 时间 ----------
    match_time, time_error = parse_time(columns["比赛时间"])
    if time_error:
        problems.append(time_error)

    # ---------- 项目 ----------
    type_text = cell_text(columns["项目"]).lower()
    match_type = MATCH_TYPE_ALIASES.get(type_text)
    if match_type is None:
        problems.append(
            f"项目「{cell_text(columns['项目'])}」认不出来，只能填 单打 / 双打"
        )

    # ---------- 赛制 ----------
    game_points = parse_int(columns["分制"])
    best_of = parse_int(columns["局制"])
    if game_points not in GAME_POINTS_OPTIONS:
        problems.append(
            f"分制「{cell_text(columns['分制'])}」不受支持，只能是 "
            + "、".join(str(value) for value in GAME_POINTS_OPTIONS)
        )
        game_points = None
    if best_of not in BEST_OF_OPTIONS:
        problems.append(
            f"局制「{cell_text(columns['局制'])}」不受支持，只能是 "
            + "、".join(str(value) for value in BEST_OF_OPTIONS)
        )
        best_of = None

    # ---------- 参赛者 ----------
    slots = {
        "A队1": columns["A队1"], "A队2": columns["A队2"],
        "B队1": columns["B队1"], "B队2": columns["B队2"],
    }
    team_a, team_b = [], []
    if match_type is not None:
        size = TEAM_SIZE[match_type]
        # 单打时 A队2 / B队2 必须留空：填了多半是把双打的表改成了单打，
        # 顺手留下的名字若被静默忽略，用户会以为那位会员上了场
        for name in ("A队2", "B队2") if size == 1 else ():
            if cell_text(slots[name]):
                problems.append(f"单打不该填「{name}」，请留空")

        for name in ("A队1", "A队2")[:size]:
            team_a.append(resolve_member(cell_text(slots[name]), members))
        for name in ("B队1", "B队2")[:size]:
            team_b.append(resolve_member(cell_text(slots[name]), members))

        for name, roster in (("A", team_a), ("B", team_b)):
            if any(not player for player in roster):
                problems.append(f"{name} 队人数不够，{TEAM_SIZE[match_type]} 人制需要填满")
            if len(set(roster)) != len(roster):
                problems.append(f"{name} 队里有同一个人出现了两次")
        if not any(not player for player in team_a + team_b):
            overlap = set(team_a) & set(team_b)
            if overlap:
                problems.append(f"有会员同时出现在两队：{'、'.join(sorted(overlap))}")

    # ---------- 比分 ----------
    score_a = score_b = None
    winner = None
    if game_points and best_of:
        score_a, score_b, score_error = parse_score_columns(
            columns["A队比分"], columns["B队比分"]
        )
        if score_error:
            problems.append(score_error)
        else:
            score_errors, winner = validate_match_score(
                score_a, score_b, game_points, best_of
            )
            problems.extend(score_errors)

    # ---------- 学号能不能对上会员 ----------
    # 对不上的学号早就被 resolve_member 原样带进了队伍，这里只负责报出来。
    # 用「不在 members 里」判定，而不是「看起来不像 userId」——后者猜不准。
    if members:
        unknown = [
            cell_text(slots[name])
            for name in ("A队1", "A队2", "B队1", "B队2")
            if cell_text(slots[name]) and cell_text(slots[name]) not in members
        ]
        if unknown:
            problems.append(f"学号在会员对照里找不到：{'、'.join(sorted(set(unknown)))}")

    if problems:
        return None, problems

    # ---------- 组装 ----------
    recorder_raw = cell_text(columns["录入人"])
    recorder = resolve_member(recorder_raw, members) if recorder_raw else team_a[0]

    doc = {
        # _id 后面统一补，这里先留空占位
        "_id": "",
        "matchType": match_type,
        "pool": MATCH_TYPE_TO_POOL[match_type],
        "teamA": team_a,
        "teamB": team_b,
        "scoreA": score_a,
        "scoreB": score_b,
        "gamePoints": game_points,
        "bestOf": best_of,
        # 胜方由比分推出，表格里写了什么都不作数（表里根本没有这一列）
        "winner": winner,
        "location": cell_text(columns["场地"]),
        "matchTime": match_time,
        # 历史成绩都是已经打完、已经确认过的，直接记为已生效
        "status": MATCH_STATUS_ACTIVE,
        "eventId": cell_text(columns["赛事ID"]) or None,
        "recorder": recorder,
        "_line": line_number,
    }
    return doc, []


def import_workbook(workbook, members, season_start=None):
    """导入整张表。

    @returns {(list, list)} 文档列表；问题列表（每项含行号与问题清单）
    """
    sheet, rows = read_match_rows(workbook)
    documents = []
    problems = []
    seen_keys = {}

    for offset, values in enumerate(rows):
        line_number = offset + 2  # 第 1 行是表头
        # 空行与表头重复行都在 import_row 里被识别为空而跳过
        doc, row_problems = import_row(values, members, line_number)

        if not row_problems and doc is not None:
            key = match_natural_key(doc)
            if key in seen_keys:
                row_problems = [
                    f"与第 {seen_keys[key]} 行是同一场比赛（时间、双方、比分、录入人全都一样），"
                    "重复录入会被云端当成同一条记录"
                ]
            else:
                seen_keys[key] = line_number
                doc["_id"] = key

        if row_problems:
            problems.append({"line": line_number, "problems": row_problems})
            continue

        if doc is not None:
            # 赛季首场只用来挑刺，不参与排序：表格里的行序是人工排的，
            # 拿它做判断容易让「谁先谁后」的错误被掩盖过去
            if season_start and doc["matchTime"] < season_start:
                problems.append({
                    "line": line_number,
                    "problems": [f"比赛时间早于赛季首场（{season_start}）"],
                })
                continue
            documents.append(doc)

    for doc in documents:
        doc.pop("_line", None)

    return documents, problems


def earliest_time(documents):
    """这批比赛里最早的一场。它就是赛季锚点的候选值，需要人工确认。"""
    if not documents:
        return None
    return min(doc["matchTime"] for doc in documents)


# ============================================================
# 报告与模板
# ============================================================
HEAD_FONT = Font(bold=True, color="FFFFFF")
HEAD_FILL = PatternFill("solid", fgColor="C00000")
NOTE_FONT = Font(size=10, color="595959")
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(vertical="top", wrap_text=True)
CENTER = Alignment(horizontal="center", vertical="center")

HEAD_FILL_BLUE = PatternFill("solid", fgColor="4472C4")
TITLE_FONT = Font(bold=True, size=14)


def style_header(sheet, row, headers, fill=HEAD_FILL_BLUE):
    for column, text in enumerate(headers, start=1):
        cell = sheet.cell(row=row, column=column, value=text)
        cell.font = HEAD_FONT
        cell.fill = fill
        cell.alignment = CENTER
        cell.border = BORDER


def autosize(sheet, widths):
    for index, width in enumerate(widths, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = width


def write_report(path, problems):
    """把问题行写成一张表，一行一条问题，便于逐条改。"""
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "问题行"

    sheet["A1"] = "导入问题清单"
    sheet["A1"].font = TITLE_FONT
    sheet["A2"] = "这些行没有被导入。改完原表后重新跑一次即可，通过的行不受影响。"
    sheet["A2"].font = NOTE_FONT

    style_header(sheet, 4, ["行号", "问题"])
    for offset, item in enumerate(problems, start=1):
        row = 4 + offset
        sheet.cell(row=row, column=1, value=item["line"]).alignment = CENTER
        cell = sheet.cell(row=row, column=2, value="；".join(item["problems"]))
        cell.alignment = WRAP
        for column in (1, 2):
            sheet.cell(row=row, column=column).border = BORDER

    autosize(sheet, [8, 100])
    workbook.save(path)


TEMPLATE_NOTES = [
    "填写说明（这份说明不影响导入，导入时只读「比赛记录」与「会员对照」两张表的数据行）：",
    "1. 项目：填「单打」或「双打」。单打只填 A队1 / B队1，A队2、B队2 必须留空。",
    "2. 队名格子填「学号」，学号与会员的对应关系写在「会员对照」表里。",
    "3. 比分两种写法都行，选一种不要混：分列写（A队比分=11,11  B队比分=9,7），"
    "或合并写（A队比分=11:9,11:7，B队比分留空）。多局用逗号隔开。",
    "4. 分制填 11 / 15 / 21，局制填 1 / 3 / 5。胜负由比分自动推出，不用也不能填胜方。",
    "5. 录入人填学号；留空时默认取 A队1。赛事ID 可留空。",
    "6. 备注列给人看，导入时会被忽略——需要长期保留的信息请写进场地或赛事ID。",
    "7. 任何一行有问题都会整行进「问题清单」，不会被悄悄导入半条。",
    "",
    "示例（一行单打、一行双打），照着往下面的表格里填就行：",
    "    2026-04-08 18:00 | 单打 | 20230001 |      | 20230002 |      | 11,11  | 9,7    | 11 | 3 | 体育馆1号场 | 20230001 |      |",
    "    2026-04-10 18:00 | 双打 | 20230001 | 20230002 | 20230003 | 20230004 | 11,9,11 | 9,11,9 | 11 | 3 | 体育馆1号场 | 20230001 |      |",
    "",
    "模板里刻意不放示例数据行：留着它们，第一次导入就会把示例当成真成绩导进去。",
]


def write_template(path):
    """生成空白模板：两张表 + 说明 + 几行示例。"""
    workbook = Workbook()

    sheet = workbook.active
    sheet.title = SHEET_MATCHES
    sheet["A1"] = "比赛记录　—— 每行一场，从第 3 行开始填"
    sheet["A1"].font = TITLE_FONT
    for offset, note in enumerate(TEMPLATE_NOTES):
        cell = sheet.cell(row=2 + offset, column=1, value=note)
        cell.font = NOTE_FONT

    head = 2 + len(TEMPLATE_NOTES) + 1
    style_header(sheet, head, MATCH_COLUMNS)
    # 表头下面留一栏空行，用户从这里往下填；空行会被导入器自动跳过
    for offset in range(1, 21):
        for column in range(1, len(MATCH_COLUMNS) + 1):
            sheet.cell(row=head + offset, column=column).border = BORDER

    autosize(sheet, [18, 8, 12, 12, 12, 12, 12, 12, 8, 8, 20, 12, 12, 20])

    members = workbook.create_sheet(SHEET_MEMBERS)
    members["A1"] = "会员对照　—— 学号与小程序里的 userId 一一对应"
    members["A1"].font = TITLE_FONT
    style_header(members, 3, MEMBER_COLUMNS)
    for offset, row in enumerate(
        [
            ["20230001", "巴特尔", "u01"],
            ["20230002", "张宇轩", "u02"],
            ["20230003", "李思远", "u03"],
            ["20230004", "王浩然", "u04"],
        ],
        start=1,
    ):
        for column, value in enumerate(row, start=1):
            cell = members.cell(row=3 + offset, column=column, value=value)
            cell.border = BORDER
    autosize(members, [14, 14, 14])

    workbook.save(path)


# ============================================================
# 命令行
# ============================================================

def build_parser():
    parser = argparse.ArgumentParser(
        prog="import-matches.py",
        description="把俱乐部的历史成绩表导入成小程序能用的比赛流水（JSON）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("input", nargs="?", help="输入的成绩表（.xlsx）")
    parser.add_argument("output", nargs="?", help="输出的比赛流水（.json）")
    parser.add_argument("--members", help="会员对照 JSON，格式 {\"学号\": \"userId\"}")
    parser.add_argument("--report", help="把有问题的行写成一张表（.xlsx）")
    parser.add_argument("--season-start", help="赛季首场时间，如 2026-04-08；早于它的行会被标为问题")
    parser.add_argument("--template", help="只生成一份空白模板（.xlsx），不执行导入")
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.template:
        write_template(args.template)
        print(f"已生成模板：{args.template}")
        return 0

    if not args.input or not args.output:
        parser.error("需要同时给出输入表格与输出 JSON（或改用 --template 生成模板）")

    season_start = None
    if args.season_start:
        season_start, error = parse_time(args.season_start)
        if error or not season_start:
            sys.stderr.write(
                f"读不懂的 --season-start：{args.season_start}，"
                "建议写成 2026-04-08 或 2026-04-08 18:00\n"
            )
            return 1

    try:
        workbook = load_workbook(args.input, data_only=True)
    except FileNotFoundError:
        sys.stderr.write(f"找不到输入文件：{args.input}\n")
        return 1

    try:
        members = load_members(workbook, args.members)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        sys.stderr.write(f"读取会员对照失败：{error}\n")
        return 1

    try:
        documents, problems = import_workbook(workbook, members, season_start)
    except ValueError as error:
        sys.stderr.write(f"读表失败：{error}\n")
        return 1

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(documents, handle, ensure_ascii=False, indent=2)

    # 行数统计口径：通过 + 问题 = 表格里有内容的行数（空行两边都不算）
    total = len(documents) + len(problems)
    print(f"共 {total} 行，通过 {len(documents)} 行，问题 {len(problems)} 行")

    anchor = earliest_time(documents)
    if anchor:
        # 赛季锚点决定谁是「创始会员」。它是全站分数的地基，工具只负责
        # 把观察值报出来，最终以俱乐部确认的日期为准（可用 --season-start 复核）。
        print(f"已导入比赛中最早的一场：{anchor}　（赛季锚点候选，请核对确认）")
    else:
        print("没有一行通过，先照报告把原表改好再跑一次")

    if problems:
        print("问题行（未被导入）：")
        for item in problems:
            print(f"  第 {item['line']} 行：" + "；".join(item["problems"]))
        if args.report:
            write_report(args.report, problems)
            print(f"问题清单已写入：{args.report}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
