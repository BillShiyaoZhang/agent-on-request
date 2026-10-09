"""Build the vector A0 academic poster and its editable SVG companion."""
from pathlib import Path
from html import escape
import base64
import json

from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor
from reportlab.lib.units import mm

OUT = Path(__file__).resolve().parent
PAGE_W, PAGE_H = 1189 * mm, 841 * mm
SCALE = 2.0
W, H = PAGE_W / SCALE, PAGE_H / SCALE
FONT_FILES = {
    "regular": "/System/Library/Fonts/Supplemental/Arial.ttf",
    "bold": "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "italic": "/System/Library/Fonts/Supplemental/Arial Italic.ttf",
}
for role, path in FONT_FILES.items():
    pdfmetrics.registerFont(TTFont(role, path))

NAVY = "#142C40"
INK = "#193345"
GRAY = "#4B6170"
TEAL = "#007D79"
TEAL_PALE = "#E7F4F1"
BLUE_PALE = "#EAF0F7"
BLUE = "#3F648D"
PURPLE = "#6B5791"
PURPLE_PALE = "#F0ECF6"
RULE = "#CFDBE2"
PAPER = "#FCFDFE"
LIGHT = "#F2F6F8"
CORAL = "#9D5140"
CORAL_PALE = "#FAEEE9"
WHITE = "#FFFFFF"

scene = []
text_records = []

def rect(x, y, w, h, fill, stroke=None, radius=0, sw=1):
    scene.append(dict(kind="rect", x=x, y=y, w=w, h=h, fill=fill,
                      stroke=stroke, radius=radius, sw=sw))

def line(x1, y1, x2, y2, color=RULE, sw=1, dash=None):
    scene.append(dict(kind="line", x1=x1, y1=y1, x2=x2, y2=y2,
                      color=color, sw=sw, dash=dash))

def polygon(points, fill):
    scene.append(dict(kind="polygon", points=points, fill=fill))

def arrow(x1, y, x2, color=GRAY, sw=1.6):
    line(x1, y, x2-6, y, color, sw)
    polygon([(x2, y), (x2-7, y-4), (x2-7, y+4)], color)

def two_way_arrow(x1, y, x2, color=GRAY, sw=1.6):
    line(x1+6, y, x2-6, y, color, sw)
    polygon([(x1, y), (x1+7, y-4), (x1+7, y+4)], color)
    polygon([(x2, y), (x2-7, y-4), (x2-7, y+4)], color)

def text(x, y, value, size=18, role="regular", color=INK, align="left", spacing=0):
    width = pdfmetrics.stringWidth(value, role, size) + max(0, len(value)-1)*spacing
    left = x if align == "left" else x-width if align == "right" else x-width/2
    assert left >= -0.1 and left + width <= W + 0.1, (value, left, width)
    assert y >= 0 and y + size <= H + 0.1, (value, y)
    record = dict(kind="text", x=left, y=y, text=value, size=size,
                  role=role, color=color, spacing=spacing)
    scene.append(record)
    text_records.append(record)
    return width

def para(x, y, value, width, size=18, leading=25, role="regular", color=INK, max_h=None):
    lines = []
    for raw in value.split("\n"):
        if not raw:
            lines.append("")
            continue
        current = ""
        for word in raw.split():
            trial = f"{current} {word}" if current else word
            if pdfmetrics.stringWidth(trial, role, size) <= width:
                current = trial
            else:
                assert current, (word, width)
                lines.append(current)
                current = word
        lines.append(current)
    height = len(lines)*leading
    if max_h is not None:
        assert height <= max_h, (value, height, max_h)
    for i, value in enumerate(lines):
        if value:
            text(x, y+i*leading, value, size, role, color)
    return y+height

def section(x, y, w, number, heading):
    rect(x, y+1, 29, 29, TEAL_PALE, radius=6)
    text(x+14.5, y+8, number, 12, "bold", TEAL, "center")
    text(x+42, y+3, heading, 22, "bold")
    line(x, y+43, x+w, y+43, RULE, 1.2)

# Header and research question.
rect(0, 0, W, H, PAPER)
rect(0, 0, W, 266, NAVY)
rect(54, 31, 5, 15, "#61D2BB")
text(70, 31, "CROSS-DOMAIN AGENT COLLABORATION", 13.5, "bold", "#88DCCB", spacing=1.2)
text(54, 64, "Ontology-Guided Collaboration", 50, "bold", WHITE)
text(54, 122, "Among Personal Assistants", 50, "bold", WHITE)
text(56, 196, "Shiyao Zhang", 23, "bold", WHITE)
text(56, 227, "Xi'an Jiaotong-Liverpool University", 18.5, "regular", "#CDDDE6")
line(1260, 67, 1260, 165, "#537184", 1.5)
text(1287, 73, "Agent on Request", 25, "bold", "#88DCCB")
para(1287, 112, "An interactive demo of\npersonal-assistant collaboration", 325,
     18, 25, color="#D6E5ED", max_h=60)

rect(54, 290, W-108, 94, TEAL_PALE, radius=9)
text(76, 312, "RESEARCH", 15, "bold", TEAL, spacing=.9)
text(76, 335, "QUESTION", 15, "bold", TEAL, spacing=.9)
line(230, 310, 230, 365, "#B4D9CF", 1.5)
text(254, 308, "How can independently owned assistants coordinate a task", 26.5, "bold")
text(254, 345, "when their concepts and disclosure boundaries differ?", 26.5, "bold")

LX, LW = 54, 348
CX, CW = 442, 748
RX, RW = 1230, W-1230-54

# Left column: motivation and the research approach from the supplied abstract.
section(LX, 423, LW, "01", "Motivation")
y = para(LX, 482,
    "A large language model (LLM) can miss the user's intended meaning or acceptable sharing boundary.",
    LW, 18.5, 26)
y = para(LX, y+17,
    "Across stakeholders, assistants may model the same concept differently and follow different disclosure policies. Collaboration needs coordination of meaning and authorization.",
    LW, 18.5, 26)
assert y <= 708, y

section(LX, 721, LW, "02", "Research approach")
text(LX, 782, "Ontology as context", 19, "bold", TEAL)
para(LX, 813, "Concept relations guide reasoning. A state registry records received facts and provenance.", LW,
     18, 24, max_h=72)
text(LX, 903, "Task-driven modular alignment", 19, "bold", TEAL)
para(LX, 934, "Align the concepts needed for the current task while retaining local representations.", LW,
     18, 24, max_h=72)
line(LX, 1026, LX+LW, 1026, RULE)
para(LX, 1045,
    "This demo builds on prior work in cross-domain agent dialogue for ontology alignment and data exchange.",
    LW, 15.5, 21, color=GRAY, max_h=84)

# Center: conceptual research framework, deliberately distinct from implementation.
section(CX, 423, CW, "03", "Collaboration framework")
text(CX, 483, "CONCEPTUAL RESEARCH MODEL", 12.5, "bold", GRAY, spacing=.8)

AY, AH = 518, 239
AX, AW = CX, 220
BX, BW = CX+528, 220
rect(AX, AY, AW, AH, WHITE, "#A8CFC9", radius=10, sw=1.4)
rect(AX, AY, AW, 63, TEAL_PALE, radius=10)
rect(AX, AY+47, AW, 16, TEAL_PALE)
text(AX+20, AY+14, "ALICE", 21, "bold", TEAL)
text(AX+20, AY+41, "Stakeholder A", 13.5, color=GRAY)

rect(BX, AY, BW, AH, WHITE, "#C8BDD8", radius=10, sw=1.4)
rect(BX, AY, BW, 63, PURPLE_PALE, radius=10)
rect(BX, AY+47, BW, 16, PURPLE_PALE)
text(BX+20, AY+14, "BOB", 21, "bold", PURPLE)
text(BX+20, AY+41, "Stakeholder B", 13.5, color=GRAY)

for x, accent in [(AX, TEAL), (BX, PURPLE)]:
    text(x+19, AY+85, "Local ontology", 18, "bold", accent)
    text(x+19, AY+113, "Concepts and relations", 15.5, color=GRAY)
    line(x+19, AY+147, x+201, AY+147, RULE)
    text(x+19, AY+162, "Own data and skills", 16.5, "bold")
    text(x+19, AY+196, "Own disclosure policy", 16.5, "bold")

MX, MW = CX+262, 224
rect(MX, AY+48, MW, 146, BLUE_PALE, "#BDCEDF", radius=9, sw=1.3)
text(MX+MW/2, AY+67, "TASK MODULE", 12.5, "bold", BLUE, "center", spacing=.6)
text(MX+MW/2, AY+95, "Meeting scheduling", 18, "bold", INK, "center")
text(MX+MW/2, AY+127, "Align task-relevant", 16, "regular", GRAY, "center")
text(MX+MW/2, AY+152, "concepts", 16, "regular", GRAY, "center")
two_way_arrow(AX+AW+6, AY+120, MX-5, TEAL)
two_way_arrow(MX+MW+5, AY+120, BX-6, PURPLE)
para(CX, 775,
     "Research model: align meaning for the task. The prototype implements configurable knowledge graphs and scoped data exchange.",
     CW, 14, 19, color=GRAY, max_h=38)

# Actual prototype path.
text(CX, 835, "PROTOTYPE EXECUTION PATH", 12.5, "bold", GRAY, spacing=.8)
path_labels = [
    ("Planner proposal", "Live LLM / Controlled"),
    ("Authorize", "Owner-defined scope"),
    ("Exchange", "Approved snapshot"),
    ("Update state", "Confirmed receipt"),
]
PW, GAP = 172, 20
for i, (label, caption) in enumerate(path_labels):
    x = CX + i*(PW+GAP)
    rect(x, 864, PW, 72, LIGHT, RULE, radius=6)
    text(x+PW/2, 879, label, 16.5, "bold", INK, "center")
    text(x+PW/2, 907, caption, 12.5, color=GRAY, align="center")
    if i < 3:
        arrow(x+PW+3, 900, x+PW+GAP-3, GRAY, 1.2)

section(CX, 962, CW, "04", "Reference demonstration")
steps = [
    ("1  Share", "Tue-Wed\nfree slots"),
    ("2  Extend", "Thu free\nslots only"),
    ("3  Match", "Thu\n15:00-15:30"),
    ("4  Approve", "Bob's owner:\ntopic only"),
    ("5  Inspect", "Confirmed\nreceived state"),
]
SW, SG = 140, 12
for i, (label, value) in enumerate(steps):
    x = CX + i*(SW+SG)
    fill = TEAL_PALE if i == 2 else LIGHT
    rect(x, 1024, SW, 86, fill, radius=6)
    text(x+12, 1036, label, 15, "bold", TEAL if i==2 else INK)
    para(x+12, 1062, value, SW-20, 14.5, 20, color=GRAY, max_h=40)
    if i < 4:
        arrow(x+SW+2, 1068, x+SW+SG-2, GRAY, 1)
text(CX, 1122, "No initial overlap. Adding Thursday enables a match. Keeping a boundary or declining remain valid.", 12.5, color=GRAY)

# Right column: concrete disclosure controls and research questions.
section(RX, 423, RW, "05", "Disclosure control")
text(RX, 481, "The model proposes.", 21, "bold")
text(RX, 512, "Permissions govern execution.", 21, "bold")

text(RX, 551, "Example calendar projection", 13.5, color=GRAY)
TY = 577
rect(RX, TY, RW, 145, WHITE, RULE, radius=7)
rect(RX, TY, RW/2, 145, TEAL_PALE, radius=7)
rect(RX+RW/2-7, TY, 7, 145, TEAL_PALE)
rect(RX+RW/2, TY, RW/2, 145, CORAL_PALE, radius=7)
rect(RX+RW/2, TY, 7, 145, CORAL_PALE)
text(RX+19, TY+16, "SHARED", 13.5, "bold", TEAL, spacing=.6)
text(RX+RW/2+19, TY+16, "WITHHELD", 13.5, "bold", CORAL, spacing=.6)
para(RX+19, TY+46, "day\ntime\nstatus", RW/2-38, 18, 27, max_h=81)
para(RX+RW/2+19, TY+46, "title\nnote", RW/2-38, 18, 27, max_h=81)

para(RX, 746,
    "Exact previews and scoped permissions restrict fields, dates, uses and expiry. Confirmed receipts determine what enters the recipient's knowledge.",
    RW, 18, 25, max_h=125)
rect(RX, 856, RW, 63, BLUE_PALE, radius=6)
para(RX+16, 868, "Stopping sharing blocks future disclosure. Already received copies remain.", RW-32,
     16, 22, max_h=44)

section(RX, 951, RW, "06", "Research instrument")
para(RX, 1009,
    "An exploratory demo with synthetic data and optional, separately consented state traces.",
    RW, 17, 23, max_h=69)
para(RX, 1084,
    "Next: semantic conflicts, module selection and users' understanding of disclosure boundaries.",
    RW, 16, 21, color=GRAY, max_h=63)

# Footer. No invented venue, URL, scholarly citation or measured result.
rect(0, 1163, W, H-1163, NAVY)
text(54, 1172, "Exploratory prototype. User studies and quantitative alignment evaluation remain future work.", 13.5, color="#D6E5ED")
text(W-54, 1172, "A0  /  1189 x 841 mm", 13.5, color="#88DCCB", align="right")


def export_pdf():
    c = canvas.Canvas(str(OUT / "academic-poster-a0.pdf"), pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    c.setTitle("Ontology-Guided Collaboration Among Personal Assistants")
    c.setAuthor("Shiyao Zhang")
    c.setSubject("Agent on Request: academic poster, Xi'an Jiaotong-Liverpool University")
    c.scale(SCALE, SCALE)
    for obj in scene:
        k = obj["kind"]
        c.setDash()
        if k == "rect":
            c.setFillColor(HexColor(obj["fill"]))
            c.setStrokeColor(HexColor(obj["stroke"] or obj["fill"]))
            c.setLineWidth(obj["sw"])
            c.roundRect(obj["x"], H-obj["y"]-obj["h"], obj["w"], obj["h"], obj["radius"],
                        fill=1, stroke=1 if obj["stroke"] else 0)
        elif k == "line":
            c.setStrokeColor(HexColor(obj["color"]))
            c.setLineWidth(obj["sw"])
            if obj["dash"]:
                c.setDash(obj["dash"])
            c.line(obj["x1"], H-obj["y1"], obj["x2"], H-obj["y2"])
        elif k == "polygon":
            c.setFillColor(HexColor(obj["fill"]))
            p = c.beginPath()
            for i, (x, y) in enumerate(obj["points"]):
                (p.moveTo if i == 0 else p.lineTo)(x, H-y)
            p.close()
            c.drawPath(p, stroke=0, fill=1)
        elif k == "text":
            c.setFillColor(HexColor(obj["color"]))
            t = c.beginText(obj["x"], H-obj["y"]-.8*obj["size"])
            t.setFont(obj["role"], obj["size"])
            t.setCharSpace(obj["spacing"])
            t.textLine(obj["text"])
            c.drawText(t)
    c.showPage()
    c.save()


def export_svg():
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1189mm" height="841mm" viewBox="0 0 {W} {H}">',
             '<title>Ontology-Guided Collaboration Among Personal Assistants</title>',
             '<desc>Academic poster by Shiyao Zhang, Xi\'an Jiaotong-Liverpool University. All text and diagrams are editable vector objects.</desc>',
             '<defs><style>']
    for role, path in FONT_FILES.items():
        b64 = base64.b64encode(Path(path).read_bytes()).decode()
        weight = 700 if role == "bold" else 400
        style = "italic" if role == "italic" else "normal"
        parts.append(f'@font-face{{font-family:poster-{role};font-weight:{weight};font-style:{style};src:url(data:font/ttf;base64,{b64}) format("truetype");}}')
    parts.append('</style></defs>')
    for obj in scene:
        k = obj["kind"]
        if k == "rect":
            parts.append(f'<rect x="{obj["x"]}" y="{obj["y"]}" width="{obj["w"]}" height="{obj["h"]}" rx="{obj["radius"]}" fill="{obj["fill"]}" stroke="{obj["stroke"] or "none"}" stroke-width="{obj["sw"]}"/>')
        elif k == "line":
            parts.append(f'<line x1="{obj["x1"]}" y1="{obj["y1"]}" x2="{obj["x2"]}" y2="{obj["y2"]}" stroke="{obj["color"]}" stroke-width="{obj["sw"]}"/>')
        elif k == "polygon":
            points = ' '.join(f'{x},{y}' for x,y in obj["points"])
            parts.append(f'<polygon points="{points}" fill="{obj["fill"]}"/>')
        elif k == "text":
            weight = 700 if obj["role"] == "bold" else 400
            style = "italic" if obj["role"] == "italic" else "normal"
            parts.append(f'<text x="{obj["x"]}" y="{obj["y"]+.8*obj["size"]}" font-family="poster-{obj["role"]},Arial,sans-serif" font-weight="{weight}" font-style="{style}" font-size="{obj["size"]}" fill="{obj["color"]}" letter-spacing="{obj["spacing"]}">{escape(obj["text"])}</text>')
    parts.append('</svg>')
    (OUT / "academic-poster-a0-editable.svg").write_text('\n'.join(parts))


if __name__ == "__main__":
    export_pdf()
    export_svg()
    (OUT / "poster-scene.json").write_text(json.dumps(scene, indent=2))
    print(json.dumps({"pdf": str(OUT / "academic-poster-a0.pdf"),
                      "svg": str(OUT / "academic-poster-a0-editable.svg"),
                      "page_mm": [1189, 841], "text_objects": len(text_records),
                      "word_count": sum(len(t["text"].split()) for t in text_records)}))
