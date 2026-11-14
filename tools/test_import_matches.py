"""
import-matches.py 的单元测试。

用法：
    python -m unittest tools.test_import_matches

测试自己用 openpyxl 现造表格（写进临时目录，用完即删），因此仓库里不需要
存放任何测试用的 xlsx——那些二进制文件一旦提交，改一次表格就要动一次仓库，
而且 diff 里什么都看不出来。

这里盯的是「导错」这一类问题：比分明明不合法却被导进去、学号对不上却
当成新会员放行、同一场比赛因为队友顺序不同被当成两场。等级分是零和的，
一条错记录至少让两个人的分数一起错，而且事后极难发现——宁可在这里拦死。
"""

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent


def load_importer():
    """按路径加载 import-matches.py。

    文件名带连字符，没法用普通的 import 语句，只能走 importlib。
    """
    spec = importlib.util.spec_from_file_location(
        "import_matches", TOOLS_DIR / "import-matches.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


im = load_importer()

from openpyxl import Workbook, load_workbook  # noqa: E402  (依赖先由上面探明)

# 会员对照：学号 → userId。刻意让两者不同，好发现「拿学号当 userId」的偷懒
MEMBERS = [
    ("20230001", "巴特尔", "u01"),
    ("20230002", "张宇轩", "u02"),
    ("20230003", "李思远", "u03"),
    ("20230004", "王浩然", "u04"),
]

HEAD = im.MATCH_COLUMNS


def blank_row(**overrides):
    """造一行空白行，再按名字覆盖需要的列。"""
    row = {name: None for name in HEAD}
    row.update(overrides)
    return [row[name] for name in HEAD]


class ImportTestCase(unittest.TestCase):
    """公共夹具：一个临时目录、一次导入、一份读回来的结果。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.input = self.tmp / "成绩表.xlsx"
        self.output = self.tmp / "matches.json"

    def tearDown(self):
        self._tmp.cleanup()

    def write_workbook(self, rows, members=MEMBERS, extra_notes=()):
        """把行写进「比赛记录」表，「会员对照」表带上 enabled 的对照项。"""
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = im.SHEET_MATCHES
        for note in extra_notes:
            sheet.append([note])
        sheet.append(HEAD)
        for row in rows:
            sheet.append(row)

        if members is not None:
            sheet_members = workbook.create_sheet(im.SHEET_MEMBERS)
            sheet_members.append(im.MEMBER_COLUMNS)
            for student_id, name, user_id in members:
                sheet_members.append([student_id, name, user_id])

        workbook.save(self.input)

    def run_import(self, rows, args=(), members=MEMBERS, extra_notes=()):
        """跑一次导入，返回（文档列表, 退出码, 打印出来的文字）。"""
        self.write_workbook(rows, members=members, extra_notes=extra_notes)
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = im.main([str(self.input), str(self.output), *args])
        text = buffer.getvalue()

        documents = []
        if self.output.exists():
            documents = json.loads(self.output.read_text(encoding="utf-8"))
        return documents, code, text

    def run_rows(self, rows, **kwargs):
        """导入并断言「一行都没通过」，返回打印文字供断言问题文案。"""
        documents, code, text = self.run_import(rows, **kwargs)
        self.assertEqual(code, 0, "有问题的行是正常结果，退出码不该非 0")
        self.assertEqual(documents, [], "有问题的行不该被导入")
        return text


class TestHappyPath(ImportTestCase):
    def test_单打分列比分被完整导入(self):
        documents, code, text = self.run_import([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9,7",
                "分制": 11, "局制": 3, "场地": "体育馆 1 号场", "录入人": "20230001",
            })
        ])

        self.assertEqual(code, 0)
        self.assertEqual(len(documents), 1)
        self.assertIn("共 1 行，通过 1 行，问题 0 行", text)

        doc = documents[0]
        self.assertEqual(doc["teamA"], ["u01"])
        self.assertEqual(doc["teamB"], ["u02"])
        self.assertEqual(doc["scoreA"], [11, 11])
        self.assertEqual(doc["scoreB"], [9, 7])
        self.assertEqual(doc["pool"], "singles")
        self.assertEqual(doc["winner"], "A")
        self.assertEqual(doc["matchType"], im.MATCH_TYPE_SINGLES)
        self.assertEqual(doc["status"], im.MATCH_STATUS_ACTIVE)
        self.assertEqual(doc["gamePoints"], 11)
        self.assertEqual(doc["bestOf"], 3)
        self.assertEqual(doc["matchTime"], "2026-04-08T18:00:00")
        self.assertIsNone(doc["eventId"])
        self.assertTrue(doc["_id"].startswith("m_"), "_id 应当是内容哈希")

    def test_双打四人各就各位(self):
        documents, _, _ = self.run_import([
            blank_row(**{
                "比赛时间": "2026-04-10 18:00", "项目": "双打",
                "A队1": "20230001", "A队2": "20230002",
                "B队1": "20230003", "B队2": "20230004",
                "A队比分": "11,9,11", "B队比分": "9,11,9",
                "分制": 11, "局制": 3,
            })
        ])

        doc = documents[0]
        self.assertEqual(doc["pool"], "doubles")
        self.assertEqual(doc["teamA"], ["u01", "u02"])
        self.assertEqual(doc["teamB"], ["u03", "u04"])
        self.assertEqual(doc["winner"], "A")

    def test_合并写法与分列写法等价(self):
        merged, _, _ = self.run_import([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11:9,11:7", "分制": 11, "局制": 3,
            })
        ])
        split, _, _ = self.run_import([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            })
        ])

        # 两种写法描述的是同一场比赛，自然键必须相同——否则同一场会被导两遍
        self.assertEqual(merged[0]["scoreA"], [11, 11])
        self.assertEqual(merged[0]["scoreB"], [9, 7])
        self.assertEqual(merged[0]["_id"], split[0]["_id"])

    def test_全角逗号与数字型学号都能读(self):
        documents, _, text = self.run_import([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": 20230001, "B队1": 20230002,  # 学号被 Excel 读成数字
                "A队比分": "11，11", "B队比分": "9，7",  # 全角逗号
                "分制": 11, "局制": 3,
            })
        ])

        self.assertEqual(text.count("学号在会员对照里找不到"), 0)
        self.assertEqual(documents[0]["teamA"], ["u01"])

    def test_时间是日期单元格也能读(self):
        # openpyxl 会把「2026-04-08 18:00」这串文本原样存着；真表格里
        # Excel 往往存成日期序列号，读出来是 datetime 对象
        from datetime import datetime

        documents, _, _ = self.run_import([
            blank_row(**{
                "比赛时间": datetime(2026, 4, 8, 18, 0), "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            })
        ])
        self.assertEqual(documents[0]["matchTime"], "2026-04-08T18:00:00")

    def test_录入人留空时默认取A队第一位(self):
        documents, _, _ = self.run_import([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            })
        ])
        self.assertEqual(documents[0]["recorder"], "u01")

    def test_空行与填写说明行都不会被当成问题(self):
        documents, _, text = self.run_import(
            [
                blank_row(),
                blank_row(**{
                    "比赛时间": "2026-04-08 18:00", "项目": "单打",
                    "A队1": "20230001", "B队1": "20230002",
                    "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
                }),
                blank_row(),
                blank_row(),
            ],
            extra_notes=["填写说明：单打只填 A队1 / B队1", "说明行不该被当成数据"],
        )

        self.assertEqual(len(documents), 1)
        self.assertIn("共 1 行，通过 1 行，问题 0 行", text)


class TestScoreValidation(ImportTestCase):
    def test_没打完的局被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11", "B队比分": "10", "分制": 11, "局制": 1,
            })
        ])
        self.assertIn("领先 2 分", text)

    def test_没有人打到目标分被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "9", "B队比分": "7", "分制": 11, "局制": 1,
            })
        ])
        self.assertIn("没有人打到 11 分", text)

    def test_三局两胜却录成三比零被拦下(self):
        # A 队 3:0：三局两胜里根本不可能打到第三局，问题出在赢的局数对不上
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11,11", "B队比分": "9,9,9", "分制": 11, "局制": 3,
            })
        ])
        self.assertIn("需要有一方赢下 2 局", text)

    def test_决胜局之后再录一局被拦下(self):
        # A 队先赢两局，比赛在第 2 局就结束了；第 3 局是多余的
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11,9", "B队比分": "9,9,11", "分制": 11, "局制": 3,
            })
        ])
        self.assertIn("多录了 1 局", text)

    def test_局数赢不够被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11", "B队比分": "9", "分制": 11, "局制": 3,
            })
        ])
        self.assertIn("需要有一方赢下 2 局", text)

    def test_两队局数不一致被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9", "分制": 11, "局制": 3,
            })
        ])
        self.assertIn("局数不一致", text)

    def test_分制与局制超出可选范围被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 12, "局制": 4,
            })
        ])
        self.assertIn("分制「12」不受支持", text)
        self.assertIn("局制「4」不受支持", text)

    def test_合并写法与分列写法同时出现被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11:9", "B队比分": "9,7", "分制": 11, "局制": 1,
            })
        ])
        self.assertIn("B 列就必须留空", text)

    def test_胜方一律由比分推出而不是采信表格(self):
        # 表格里没有「胜方」这一列；即便是 A 队前三局全输，只要最后一局
        # 比分反超，winner 也必须是算出来的那一个
        documents, _, _ = self.run_import([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "9,9,11", "B队比分": "11,11,9", "分制": 11, "局制": 3,
            })
        ])
        # 三局两胜里 B 队先拿到 2 局，第三局不该存在——所以这一行会被拦下
        self.assertEqual(documents, [])

        documents, _, _ = self.run_import([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "9,11,11", "B队比分": "11,9,9", "分制": 11, "局制": 3,
            })
        ])
        self.assertEqual(documents[0]["winner"], "A")


class TestRosterValidation(ImportTestCase):
    def test_单打多填了第二个人被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "A队2": "20230002", "B队1": "20230003",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            })
        ])
        self.assertIn("单打不该填「A队2」", text)

    def test_双打少人被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-10 18:00", "项目": "双打",
                "A队1": "20230001", "B队1": "20230003", "B队2": "20230004",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            })
        ])
        self.assertIn("A 队人数不够", text)

    def test_同一个人在同一队里出现两次被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-10 18:00", "项目": "双打",
                "A队1": "20230001", "A队2": "20230001",
                "B队1": "20230003", "B队2": "20230004",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            })
        ])
        self.assertIn("同一个人出现了两次", text)

    def test_同一个人同时出现在两队被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230001",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            })
        ])
        self.assertIn("同时出现在两队", text)

    def test_学号在对照表里找不到被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20239999",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            })
        ])
        self.assertIn("学号在会员对照里找不到：20239999", text)

    def test_项目认不出来被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "混双",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            })
        ])
        self.assertIn("认不出来", text)

    def test_时间看不懂被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "比赛时间": "上周三晚上", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            })
        ])
        self.assertIn("看不懂的比赛时间", text)

    def test_时间留空被拦下(self):
        text = self.run_rows([
            blank_row(**{
                "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            })
        ])
        self.assertIn("比赛时间为空", text)


class TestDeduplication(ImportTestCase):
    def test_两行同一场比赛被拦下一行(self):
        row = {
            "比赛时间": "2026-04-08 18:00", "项目": "单打",
            "A队1": "20230001", "B队1": "20230002",
            "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
        }
        documents, _, text = self.import_two(blank_row(**row), blank_row(**row))

        self.assertEqual(len(documents), 1)
        self.assertIn("重复录入", text)

    def test_队友顺序不同不算两场(self):
        # 双打里同样的两个人写反了顺序，本质是同一场比赛。
        # 这里必须写明录入人：留空时默认取 A队1，而两队顺序一反过来，
        # 「A队1」就换成了另一个人，自然键随之不同——那是另一个人的记录，
        # 不是同一条被重复录入。
        documents, _, text = self.import_two(
            blank_row(**{
                "比赛时间": "2026-04-10 18:00", "项目": "双打",
                "A队1": "20230001", "A队2": "20230002",
                "B队1": "20230003", "B队2": "20230004",
                "A队比分": "11,11", "B队比分": "9,7",
                "分制": 11, "局制": 3, "录入人": "20230003",
            }),
            blank_row(**{
                "比赛时间": "2026-04-10 18:00", "项目": "双打",
                "A队1": "20230002", "A队2": "20230001",
                "B队1": "20230003", "B队2": "20230004",
                "A队比分": "11,11", "B队比分": "9,7",
                "分制": 11, "局制": 3, "录入人": "20230003",
            }),
        )

        self.assertEqual(len(documents), 1, "队友顺序不同不该被当成两场比赛")
        self.assertIn("重复录入", text)

    def import_two(self, *rows):
        """导入两行，返回（文档, 退出码, 输出文字）。"""
        return self.run_import(list(rows))


class TestSeasonStart(ImportTestCase):
    def test_不给赛季首场时只把最早一场报出来供核对(self):
        _, _, text = self.run_import([
            blank_row(**{
                "比赛时间": "2026-05-01 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            }),
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,9,11", "B队比分": "9,11,9", "分制": 11, "局制": 3,
            }),
        ])
        self.assertIn("最早的一场：2026-04-08T18:00:00", text)

    def test_早于赛季首场的行被拦下(self):
        documents, _, text = self.run_import(
            [
                blank_row(**{
                    "比赛时间": "2026-03-01 18:00", "项目": "单打",
                    "A队1": "20230001", "B队1": "20230002",
                    "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
                })
            ],
            args=["--season-start", "2026-04-08"],
        )
        self.assertEqual(documents, [])
        self.assertIn("早于赛季首场", text)


class TestMembersSource(ImportTestCase):
    def test_members参数可以替代工作表(self):
        # 工作表里没有对照项，全靠 --members 提供
        members_json = self.tmp / "members.json"
        members_json.write_text(
            json.dumps({"20230001": "u01", "20230002": "u02"}, ensure_ascii=False),
            encoding="utf-8",
        )

        self.write_workbook([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            })
        ], members=None)

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = im.main(
                [
                    str(self.input), str(self.output),
                    "--members", str(members_json),
                ]
            )
        documents = json.loads(self.output.read_text(encoding="utf-8"))

        self.assertEqual(code, 0)
        self.assertEqual(documents[0]["teamA"], ["u01"])
        self.assertIn("问题 0 行", buffer.getvalue())

    def test_既没有对照表也没给参数时明确报错(self):
        self.write_workbook([], members=None)
        buffer = io.StringIO()
        with contextlib.redirect_stderr(buffer):
            code = im.main([str(self.input), str(self.output)])
        self.assertEqual(code, 1)
        self.assertIn("找不到「会员对照」工作表", buffer.getvalue())


class TestReport(ImportTestCase):
    def test_问题清单写进报告文件(self):
        report = self.tmp / "报告.xlsx"
        documents, _, _ = self.run_import(
            [
                blank_row(**{
                    "比赛时间": "2026-04-08 18:00", "项目": "单打",
                    "A队1": "20230001", "B队1": "20230002",
                    "A队比分": "11", "B队比分": "10", "分制": 11, "局制": 1,
                }),
                blank_row(**{
                    "比赛时间": "2026-04-09 18:00", "项目": "单打",
                    "A队1": "20230001", "B队1": "20239999",
                    "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
                }),
            ],
            args=["--report", str(report)],
        )

        self.assertEqual(documents, [])
        self.assertTrue(report.exists())

        sheet = load_workbook(report).active
        lines = [
            sheet.cell(row=row, column=1).value
            for row in range(5, 5 + 2)
        ]
        self.assertEqual(lines, [2, 3], "报告要逐行记下行号，便于回原表定位")


class TestTemplate(ImportTestCase):
    def test_模板能生成且导入它是干净的空跑(self):
        template = self.tmp / "模板.xlsx"
        im.write_template(template)
        self.assertTrue(template.exists())

        workbook = load_workbook(template)
        self.assertIn(im.SHEET_MATCHES, workbook.sheetnames)
        self.assertIn(im.SHEET_MEMBERS, workbook.sheetnames)
        # 模板里的两张表都要有表头，用户才知道往哪一列填
        for column, name in enumerate(HEAD, start=1):
            self.assertIn(name, [
                workbook[im.SHEET_MATCHES].cell(row=row, column=column).value
                for row in range(1, 40)
            ])

        # 关键：模板故意不放示例数据行。否则第一次导入就会把示例当真成绩导进去
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = im.main([str(template), str(self.output)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(self.output.read_text(encoding="utf-8")), [])
        self.assertIn("共 0 行，通过 0 行，问题 0 行", buffer.getvalue())


class TestNaturalKey(ImportTestCase):
    def test_自然键随内容变化(self):
        base = blank_row(**{
            "比赛时间": "2026-04-08 18:00", "项目": "单打",
            "A队1": "20230001", "B队1": "20230002",
            "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
        })
        first, _, _ = self.run_import([base])
        second, _, _ = self.run_import([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9,8", "分制": 11, "局制": 3,
            })
        ])

        self.assertNotEqual(first[0]["_id"], second[0]["_id"])

    def test_同一天不同时间的两场是两场比赛(self):
        documents, _, _ = self.run_import([
            blank_row(**{
                "比赛时间": "2026-04-08 18:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            }),
            blank_row(**{
                "比赛时间": "2026-04-08 20:00", "项目": "单打",
                "A队1": "20230001", "B队1": "20230002",
                "A队比分": "11,11", "B队比分": "9,7", "分制": 11, "局制": 3,
            }),
        ])
        self.assertEqual(len(documents), 2)
        self.assertNotEqual(documents[0]["_id"], documents[1]["_id"])




class TestReview19Parsing(unittest.TestCase):
    def test_fractional_and_nonfinite_scores_are_rejected(self):
        for value in ['11.9', 'nan', 'inf', '-inf']:
            self.assertIsNone(im.parse_int(value))
            self.assertIsNone(im.parse_scores(value)[0])
            self.assertIsNone(im.parse_score_columns(value + ':9', '')[0])
        self.assertEqual(im.parse_int('11.0'), 11)

    def test_naive_dates_are_beijing_and_explicit_offsets_preserved(self):
        self.assertEqual(im.iso_utc('2026-04-08T18:00:00'), '2026-04-08T10:00:00.000Z')
        self.assertEqual(im.iso_utc('2026-04-08T18:00:00+08:00'), '2026-04-08T10:00:00.000Z')
        self.assertEqual(im.iso_utc('2026-04-08T18:00:00+00:00'), '2026-04-08T18:00:00.000Z')

if __name__ == "__main__":
    unittest.main()
