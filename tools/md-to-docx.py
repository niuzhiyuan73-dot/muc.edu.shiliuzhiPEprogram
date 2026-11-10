"""
把 docs/ 下的需求整理 Markdown 排版成 Word 文档。

用法：
    python tools/md-to-docx.py <输入.md> [输出.docx]

依赖 python-docx。样式沿用 tools/college-design-to-docx.py 那一套
（宋体正文 / 微软雅黑标题 / Times New Roman 西文 / 1F4E79 主色 / Table Grid），
目的是让需求整理的 .md 与 .docx 只有一个内容源，不再两头手抄。

支持的 Markdown 子集（够用即可，不做通用转换器）：
    # / ## / ### 标题
    > 引用块（连续行合成一段带左边框的提示）
    | 表格 |
    - / * 无序列表
    1. 有序列表（保留字面编号，避免 Word 自动编号跨列表续号）
    ``` 代码块 ```（原样等宽排版，用来画分期流程图）
    --- 分隔线
    行内 **加粗** 与 `代码`
"""

import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

BODY_EA = "宋体"
HEAD_EA = "微软雅黑"
CODE_FONT = "Consolas"
ASCII_FONT = "Times New Roman"
ACCENT = RGBColor(0x1F, 0x4E, 0x79)
MUTED = RGBColor(0x59, 0x59, 0x59)
CODE_COLOR = RGBColor(0xA3, 0x1D, 0x1D)
HEAD_FILL = "1F4E79"
CODE_FILL = "F2F2F2"
USABLE_CM = 15.6

WIDTHS = {
    2: [3.4, 12.2],
    3: [2.6, 6.5, 6.5],
    4: [1.6, 6.0, 3.0, 5.0],
}


def set_font(run, size=10.5, bold=False, color=None, ea=BODY_EA, ascii_font=ASCII_FONT):
    run.font.name = ascii_font
    run.font.size = Pt(size)
    run.font.bold = bold
    if color is not None:
        run.font.color.rgb = color
    run._element.rPr.rFonts.set(qn("w:eastAsia"), ea)


def shade(cell, color):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), color)
    tc_pr.append(shd)


def left_border(paragraph, color="1F4E79"):
    p_pr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    left = OxmlElement("w:left")
    left.set(qn("w:val"), "single")
    left.set(qn("w:space"), "6")
    left.set(qn("w:sz"), "18")
    left.set(qn("w:color"), color)
    borders.append(left)
    p_pr.append(borders)


INLINE = re.compile(r"(\*\*.+?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))")


def add_runs(paragraph, text, size=10.5, bold=False, color=None):
    """把行内 **加粗** / `代码` / [链接](目标) 拆成不同字体的 run，其余原样。

    加粗里可能嵌着代码（如「**不触发 `bumpSeason`**」），所以加粗那一支
    递归再拆一次，否则反引号会原样露在 Word 里。

    链接只保留可读文字：仓库内相对链接（指向别的 .md）在 Word 里点不开，
    把 `[[文档名](x.md)]` 原样印出来更糟；外部 http 链接附上地址，方便纸质版查阅。
    """
    for piece in INLINE.split(text):
        if not piece:
            continue
        if piece.startswith("**") and piece.endswith("**") and len(piece) > 4:
            add_runs(paragraph, piece[2:-2], size=size, bold=True, color=color)
        elif piece.startswith("`") and piece.endswith("`") and len(piece) > 2:
            run = paragraph.add_run(piece[1:-1])
            set_font(run, size=size - 0.5, bold=bold, color=CODE_COLOR, ea=BODY_EA, ascii_font=CODE_FONT)
        elif piece.startswith("[") and "](" in piece and piece.endswith(")"):
            label, _, target = piece[1:-1].partition("](")
            add_runs(paragraph, label, size=size, bold=bold, color=color)
            if target.startswith("http"):
                run = paragraph.add_run(f"（{target}）")
                set_font(run, size=size - 0.5, bold=bold, color=MUTED)
        else:
            run = paragraph.add_run(piece)
            set_font(run, size=size, bold=bold, color=color)


def heading(doc, text, level):
    # 标题不做行内排版，去掉标记符，免得 Word 里露出反引号与星号
    text = text.replace("`", "").replace("**", "")
    sizes = {1: 16, 2: 13, 3: 11.5}
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_before = Pt(14 if level == 1 else 10)
    paragraph.paragraph_format.space_after = Pt(6)
    run = paragraph.add_run(text)
    set_font(run, size=sizes.get(level, 11.5), bold=True, color=ACCENT, ea=HEAD_EA)
    return paragraph


def flush_quote(doc, lines):
    for index, text in enumerate(lines):
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.left_indent = Cm(0.4)
        paragraph.paragraph_format.space_before = Pt(4 if index == 0 else 0)
        paragraph.paragraph_format.space_after = Pt(6 if index == len(lines) - 1 else 0)
        paragraph.paragraph_format.line_spacing = 1.2
        add_runs(paragraph, text, size=10, color=MUTED)
        left_border(paragraph)


def table(doc, headers, rows):
    cols = len(headers)
    widths = WIDTHS.get(cols) or [USABLE_CM / cols] * cols
    tbl = doc.add_table(rows=1, cols=cols)
    tbl.style = "Table Grid"
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    head_cells = tbl.rows[0].cells
    for index, text in enumerate(headers):
        head_cells[index].text = ""
        paragraph = head_cells[index].paragraphs[0]
        run = paragraph.add_run(text)
        set_font(run, size=10, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF), ea=HEAD_EA)
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        shade(head_cells[index], HEAD_FILL)
    for row in rows:
        cells = tbl.add_row().cells
        for index, value in enumerate(row):
            if index >= cols:
                break
            cells[index].text = ""
            paragraph = cells[index].paragraphs[0]
            paragraph.paragraph_format.line_spacing = 1.15
            add_runs(paragraph, value, size=9.5)
    for row in tbl.rows:
        for index, width in enumerate(widths):
            row.cells[index].width = Cm(width)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return tbl


def code_block(doc, lines):
    for index, text in enumerate(lines):
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.left_indent = Cm(0.5)
        paragraph.paragraph_format.line_spacing = 1.0
        paragraph.paragraph_format.space_before = Pt(4 if index == 0 else 0)
        paragraph.paragraph_format.space_after = Pt(4 if index == len(lines) - 1 else 0)
        run = paragraph.add_run(text)
        set_font(run, size=9, ea=BODY_EA, ascii_font=CODE_FONT)
        if not text.strip():
            continue
        p_pr = paragraph._p.get_or_add_pPr()
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:fill"), CODE_FILL)
        p_pr.append(shd)


def split_row(line):
    body = line.strip().strip("|")
    return [cell.strip() for cell in body.split("|")]


def is_separator(line):
    return bool(re.fullmatch(r"\|?[\s:|-]+\|?", line.strip())) and "-" in line


def build(doc, lines):
    index = 0
    total = len(lines)
    while index < total:
        line = lines[index]
        stripped = line.strip()

        if stripped.startswith("```"):
            index += 1
            code = []
            while index < total and not lines[index].strip().startswith("```"):
                code.append(lines[index])
                index += 1
            index += 1
            code_block(doc, code)
            continue

        if not stripped:
            index += 1
            continue

        if stripped == "---":
            spacer = doc.add_paragraph()
            spacer.paragraph_format.space_after = Pt(2)
            index += 1
            continue

        if stripped.startswith(">"):
            quote = []
            while index < total and lines[index].strip().startswith(">"):
                quote.append(lines[index].strip().lstrip(">").strip())
                index += 1
            flush_quote(doc, quote)
            continue

        if stripped.startswith("#"):
            match = re.match(r"(#+)\s+(.*)", stripped)
            level = min(len(match.group(1)), 3)
            # 一级标题已经在封面横幅上排过，正文里不再重复
            if level > 1:
                heading(doc, match.group(2), level)
            index += 1
            continue

        if stripped.startswith("|"):
            headers = split_row(stripped)
            index += 1
            if index < total and is_separator(lines[index]):
                index += 1
            rows = []
            while index < total and lines[index].strip().startswith("|"):
                rows.append(split_row(lines[index]))
                index += 1
            table(doc, headers, rows)
            continue

        bullet_match = re.match(r"[-*]\s+(.*)", stripped)
        if bullet_match:
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.left_indent = Cm(0.75)
            paragraph.paragraph_format.first_line_indent = Cm(-0.4)
            paragraph.paragraph_format.space_after = Pt(2)
            paragraph.paragraph_format.line_spacing = 1.25
            add_runs(paragraph, "• " + bullet_match.group(1))
            index += 1
            continue

        number_match = re.match(r"(\d+)[.、]\s+(.*)", stripped)
        if number_match:
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.left_indent = Cm(0.75)
            paragraph.paragraph_format.first_line_indent = Cm(-0.55)
            paragraph.paragraph_format.space_after = Pt(2)
            paragraph.paragraph_format.line_spacing = 1.25
            add_runs(paragraph, f"{number_match.group(1)}. {number_match.group(2)}")
            index += 1
            continue

        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.space_after = Pt(4)
        paragraph.paragraph_format.line_spacing = 1.25
        add_runs(paragraph, stripped)
        index += 1


def setup(doc, title, subtitle, bare=False):
    section = doc.sections[0]
    section.page_height = Cm(29.7)
    section.page_width = Cm(21)
    section.top_margin = Cm(2.2)
    section.bottom_margin = Cm(2.2)
    section.left_margin = Cm(2.4)
    section.right_margin = Cm(2.4)

    normal = doc.styles["Normal"]
    normal.font.name = ASCII_FONT
    normal.font.size = Pt(10.5)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), BODY_EA)

    if not bare:
        head = doc.add_paragraph()
        head.alignment = WD_ALIGN_PARAGRAPH.CENTER
        head.paragraph_format.space_after = Pt(2)
        run = head.add_run("中央民族大学石榴籽体育管理小程序")
        set_font(run, size=13, bold=True, color=MUTED, ea=HEAD_EA)

    banner = doc.add_paragraph()
    banner.alignment = WD_ALIGN_PARAGRAPH.CENTER
    banner.paragraph_format.space_after = Pt(18 if bare else 10)
    run = banner.add_run(subtitle or title)
    set_font(run, size=22 if bare else 24, bold=True, color=ACCENT, ea=HEAD_EA)


def main():
    raw = sys.argv[1:]
    bare = "--bare" in raw
    args = [a for a in raw if not a.startswith("--")]
    if len(args) < 1:
        print("用法：python tools/md-to-docx.py [--bare] <输入.md> [输出.docx]")
        print("  --bare  不输出项目名称小标题（用于对外签署的正式文书）")
        raise SystemExit(1)
    source = Path(args[0])
    out = Path(args[1]) if len(args) > 1 else source.with_suffix(".docx")

    lines = source.read_text(encoding="utf-8").splitlines()
    title = ""
    for line in lines:
        if line.strip().startswith("# "):
            title = line.strip()[2:].strip()
            break

    doc = Document()
    setup(doc, title, title, bare=bare)
    build(doc, lines)
    doc.save(out)
    print(f"已生成：{out}")


if __name__ == "__main__":
    main()
