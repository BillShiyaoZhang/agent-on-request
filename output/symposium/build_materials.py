"""Build three diagram-only symposium boards (two project, one interaction).

Use uv with reportlab, pillow and pypdf. All illustrations are editable vector
paths; simplified controls are labelled as a schematic, not a UI screenshot.
"""
from pathlib import Path
import math
import re
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor
from pypdf import PdfReader, PdfWriter

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / 'pdf'
OUT.mkdir(parents=True, exist_ok=True)
W, H = 841.89, 595.28
for name, file in [('R', 'Arial.ttf'), ('B', 'Arial Bold.ttf')]:
    pdfmetrics.registerFont(TTFont(name, '/System/Library/Fonts/Supplemental/' + file))
INK, MUTED, NAVY = '#16303D', '#60747B', '#122E3B'
TEAL, MINT, PURPLE, LILAC = '#087D70', '#E3F2EC', '#6B5795', '#EFEBF7'
ORANGE, PEACH, PAPER, LINE, WHITE = '#A34E34', '#FAEDE5', '#FAFAF5', '#CFDAD7', '#FFFFFF'
PATH = OUT / 'symposium-interactive-materials-draft.pdf'
old_words = sum(len(re.findall(r"\b[\w'-]+\b", p.extract_text())) for p in PdfReader(PATH).pages) if PATH.exists() else None
c = canvas.Canvas(str(PATH), pagesize=(W, H), pageCompression=1)
c.setTitle('Agent on Request - Visual project interpretation and interaction guide')
c.setAuthor('Shiyao Zhang')
placements = []


def rect(x, y, w, h, fill=WHITE, border=None, radius=12, sw=1):
    c.setFillColor(HexColor(fill)); c.setStrokeColor(HexColor(border or fill)); c.setLineWidth(sw)
    c.roundRect(x, H-y-h, w, h, radius, stroke=bool(border), fill=1)


def line(x1, y1, x2, y2, color=LINE, sw=1.5, dash=None):
    c.setStrokeColor(HexColor(color)); c.setLineWidth(sw); c.setLineCap(1)
    c.setDash(dash or []); c.line(x1, H-y1, x2, H-y2); c.setDash([])


def circle(x, y, r, fill=WHITE, border=None, sw=1.5):
    c.setFillColor(HexColor(fill)); c.setStrokeColor(HexColor(border or fill)); c.setLineWidth(sw)
    c.circle(x, H-y, r, stroke=bool(border), fill=1)


def text(x, y, value, size=12, color=INK, bold=False, align='left'):
    font = 'B' if bold else 'R'
    width = pdfmetrics.stringWidth(value, font, size)
    left = x if align == 'left' else x-width if align == 'right' else x-width/2
    assert left >= 0 and left+width <= W+0.2 and y >= 0 and y+size <= H, (value, left, y)
    c.setFont(font, size); c.setFillColor(HexColor(color)); c.drawString(left, H-y-size, value)
    placements.append((c.getPageNumber(), value, left, y, width, size))


def arrow(x1, y1, x2, y2, color=TEAL, sw=2, dash=None):
    line(x1, y1, x2, y2, color, sw, dash)
    angle = math.atan2(y2-y1, x2-x1)
    p = c.beginPath(); p.moveTo(x2, H-y2)
    for turn in (2.62, -2.62):
        p.lineTo(x2+8*math.cos(angle+turn), H-(y2+8*math.sin(angle+turn)))
    p.close(); c.setFillColor(HexColor(color)); c.drawPath(p, stroke=0, fill=1)


def bidir(x1, y, x2, color=TEAL):
    arrow(x1,y,x2,y,color); arrow(x2,y,x1,y,color)


def tick(x, y, size=16, color=TEAL):
    line(x-size*.4,y,x-size*.08,y+size*.32,color,2.4)
    line(x-size*.08,y+size*.32,x+size*.52,y-size*.4,color,2.4)


def cross(x,y,size=9,color=ORANGE):
    line(x-size,y-size,x+size,y+size,color,2)
    line(x-size,y+size,x+size,y-size,color,2)


def neq(x,y,size=30):
    line(x-size*.5,y-5,x+size*.5,y-5,ORANGE,2.5)
    line(x-size*.5,y+5,x+size*.5,y+5,ORANGE,2.5)
    line(x-7,y+15,x+7,y-15,ORANGE,2.5)


def person(x,y,s=1,color=TEAL,pale=MINT):
    circle(x,y-15*s,8*s,pale,color,1.8)
    c.setStrokeColor(HexColor(color)); c.setLineWidth(1.9)
    p=c.beginPath(); p.moveTo(x-16*s,H-y-15*s)
    p.curveTo(x-16*s,H-y+5*s,x+16*s,H-y+5*s,x+16*s,H-y-15*s)
    c.drawPath(p,fill=0,stroke=1)


def bot(x,y,s=1,color=TEAL,pale=MINT):
    rect(x-26*s,y-18*s,52*s,38*s,pale,color,9*s,1.8)
    line(x,y-18*s,x,y-28*s,color,1.8); circle(x,y-31*s,3*s,color)
    circle(x-10*s,y-3*s,3*s,color); circle(x+10*s,y-3*s,3*s,color)
    line(x-8*s,y+9*s,x+8*s,y+9*s,color,1.8)
    line(x-32*s,y-6*s,x-32*s,y+8*s,color,2)
    line(x+32*s,y-6*s,x+32*s,y+8*s,color,2)


def graph(x,y,s=1,color=TEAL):
    pts=[(-23,0),(-5,-20),(24,-8),(7,22)]
    for i,j in [(0,1),(1,2),(2,3),(0,3),(1,3)]:
        a,b=pts[i],pts[j]; line(x+a[0]*s,y+a[1]*s,x+b[0]*s,y+b[1]*s,color,1.8)
    for dx,dy in pts: circle(x+dx*s,y+dy*s,4*s,color)


def evidence(x,y,s=1,color=TEAL):
    for yy in [-16,0,16]:
        rect(x-22*s,y+yy*s-7*s,44*s,14*s,WHITE,color,5*s,1.5)
        line(x-13*s,y+yy*s,x+7*s,y+yy*s,color,1.4)
        circle(x+14*s,y+yy*s,2*s,color)


def skill(x,y,s=1,color=TEAL):
    # Tool handle and open wrench jaw.
    line(x-17*s,y+20*s,x+11*s,y-10*s,color,5*s)
    circle(x-17*s,y+20*s,4*s,WHITE,color,1.8)
    line(x+10*s,y-10*s,x+5*s,y-24*s,color,3*s)
    line(x+10*s,y-10*s,x+25*s,y-8*s,color,3*s)
    line(x+5*s,y-24*s,x+12*s,y-24*s,color,3*s)
    line(x+25*s,y-8*s,x+25*s,y-15*s,color,3*s)


def lock(x,y,s=1,color=TEAL,pale=MINT,opened=False):
    rect(x-18*s,y-2*s,36*s,29*s,pale,color,5*s,1.8)
    p=c.beginPath(); p.moveTo(x-10*s,H-y+2*s)
    if opened:
        p.lineTo(x-10*s,H-y+13*s); p.curveTo(x-10*s,H-y+28*s,x+15*s,H-y+28*s,x+15*s,H-y+15*s)
    else:
        p.lineTo(x-10*s,H-y+13*s); p.curveTo(x-10*s,H-y+28*s,x+10*s,H-y+28*s,x+10*s,H-y+13*s); p.lineTo(x+10*s,H-y+2*s)
    c.setStrokeColor(HexColor(color)); c.setLineWidth(2); c.drawPath(p,stroke=1,fill=0)
    circle(x,y+10*s,2.7*s,color); line(x,y+11*s,x,y+18*s,color,1.8)


def envelope(x,y,s=1,color=TEAL,pale=MINT):
    rect(x-31*s,y-19*s,62*s,39*s,pale,color,5*s,1.8)
    line(x-28*s,y-15*s,x,y+5*s,color,1.5); line(x,y+5*s,x+28*s,y-15*s,color,1.5)


def receipt(x,y,s=1,color=TEAL,pale=MINT):
    rect(x-22*s,y-31*s,44*s,62*s,WHITE,color,4*s,1.8)
    for i,ww in enumerate([25,28,17]): line(x-14*s,y+(-16+i*10)*s,x+(-14+ww)*s,y+(-16+i*10)*s,LINE,1.5)
    circle(x+12*s,y+17*s,13*s,pale,color,1.5); tick(x+12*s,y+17*s,13*s,color)


def calendar(x,y,s=1,color=TEAL,pale=MINT):
    rect(x-29*s,y-26*s,58*s,53*s,WHITE,color,6*s,1.8)
    rect(x-29*s,y-26*s,58*s,13*s,pale,radius=5*s)
    line(x-29*s,y-12*s,x+29*s,y-12*s,color,1.5)
    for xx in [-15,15]: line(x+xx*s,y-31*s,x+xx*s,y-20*s,color,2)
    for xx in [-16,0,16]:
        for yy in [-1,14]: rect(x+xx*s-4*s,y+yy*s-3*s,8*s,6*s,pale,radius=2*s)
    rect(x-4*s,y-4*s,24*s,9*s,color,radius=2*s)


def talk(x,y,s=1,color=PURPLE,pale=LILAC):
    rect(x-36*s,y-28*s,72*s,48*s,WHITE,color,5*s,1.8)
    graph(x+5*s,y-7*s,.55*s,color)
    line(x,y+21*s,x,y+32*s,color,1.8); line(x-18*s,y+33*s,x+18*s,y+33*s,color,1.8)
    circle(x-24*s,y+3*s,6*s,pale,color,1.3)
    line(x-24*s,y+10*s,x-24*s,y+24*s,color,2)


def discussion(x,y,s=1,color=ORANGE,pale=PEACH):
    rect(x-30*s,y-13*s,60*s,32*s,pale,color,12*s,1.8)
    for dx,dy in [(-20,-28),(20,-28),(-20,33),(20,33)]:
        circle(x+dx*s,y+dy*s,7*s,WHITE,color,1.8)


def room(x,y,s=1,color=TEAL,pale=MINT):
    rect(x-32*s,y-27*s,64*s,54*s,WHITE,color,5*s,1.8)
    rect(x+5*s,y-8*s,18*s,35*s,pale,color,2*s,1.3)
    circle(x+17*s,y+12*s,1.5*s,color)
    line(x-21*s,y-10*s,x-4*s,y-10*s,color,1.8)
    line(x-21*s,y+1*s,x-4*s,y+1*s,color,1.8)


def paper(x,y,s=1,color=TEAL):
    rect(x-22*s,y-29*s,44*s,58*s,WHITE,color,4*s,1.7)
    for i,ww in enumerate([27,21,27,16]): line(x-14*s,y+(-15+i*10)*s,x+(-14+ww)*s,y+(-15+i*10)*s,LINE,1.8)


def pointer(x,y,s=1,color=INK):
    p=c.beginPath(); p.moveTo(x,H-y); p.lineTo(x+3*s,H-y-24*s); p.lineTo(x+10*s,H-y-17*s)
    p.lineTo(x+16*s,H-y-28*s); p.lineTo(x+21*s,H-y-25*s); p.lineTo(x+15*s,H-y-15*s)
    p.lineTo(x+25*s,H-y-14*s); p.close()
    c.setFillColor(HexColor(WHITE)); c.setStrokeColor(HexColor(color)); c.setLineWidth(1.3); c.drawPath(p,stroke=1,fill=1)


def button(x,y,w,label,fill=NAVY,size=11,h=32):
    rect(x,y,w,h,fill,radius=7)
    labels=label.split('\n')
    if len(labels)==1: text(x+w/2,y+(h-size)/2-1,labels[0],size,WHITE,True,'center')
    else:
        for i,value in enumerate(labels): text(x+w/2,y+6+i*(size+2),value,size,WHITE,True,'center')


def checkbox(x,y,checked,label,color=TEAL,size=11):
    rect(x,y,11,11,WHITE,color if checked else LINE,2,1)
    if checked: tick(x+5,y+5,8,color)
    text(x+19,y-1,label,size,color if checked else MUTED,checked)


def number(x,y,n):
    circle(x,y,12,NAVY); text(x,y-7,str(n),11,WHITE,True,'center')


def header(title,page,sub=None):
    rect(0,0,W,H,PAPER,radius=0)
    text(32,21,'AGENT ON REQUEST',10,TEAL,True)
    text(W-32,21,'RESEARCH PROTOTYPE',9,MUTED,False,'right')
    text(32,47,title,29,INK,True)
    if sub: text(32,87,sub,11,MUTED)


def footer(page,guide=False):
    line(32,560,W-32,560,LINE,.8)
    text(32,574,'Shiyao Zhang · XJTLU',8.5,MUTED)
    text(W/2,574,'Schematic · Guided example · fictional data' if not guide else 'Guided · fictional data · run records kept',8,MUTED,False,'center')
    text(W-32,572,f'{page:02d} / 03',10,TEAL,True,'right')


# 1. Independent assistants, explicit exchange, three tasks.
header('Two assistants. One shared task.',1)
for x,name,domain,color,pale in [(32,'Alice','Semantics',TEAL,MINT),(546,'Bob','HCI',PURPLE,LILAC)]:
    rect(x,137,264,282,WHITE,LINE,18)
    circle(x+132,139,34,pale)
    person(x+132,142,1,color,pale)
    text(x+132,179,name,20,color,True,'center')
    text(x+132,205,domain,12,MUTED,False,'center')
    bot(x+132,257,1.15,color,pale)
    for ix,(icon,caption) in enumerate([(graph,'Concepts'),(evidence,'Evidence'),(skill,'Skills'),(lock,'Rules')]):
        xx=x+43+ix*59
        icon(xx,346,.64,color)
        text(xx,381,caption,10,MUTED,False,'center')
# Definitions are actually communicated; no shared private store is drawn.
bidir(302,249,539,MUTED)
rect(348,222,146,54,PAPER,radius=0)
rect(361,220,43,28,MINT,TEAL,8); rect(437,238,43,28,LILAC,PURPLE,8)
line(392,247,386,254,TEAL,1.5); line(450,265,456,272,PURPLE,1.5)
text(421,287,'Definitions',12,INK,True,'center')
# Two owner gates remain separate.
lock(359,354,.76,TEAL,MINT); lock(483,354,.76,PURPLE,LILAC)
envelope(421,354,.52,MUTED,PAPER)
text(421,398,'Permissions',11,MUTED,False,'center')
for x,icon,caption,color,pale in [(32,calendar,'Schedule',TEAL,MINT),(296,talk,'Shared talk',PURPLE,LILAC),(560,discussion,'Discussion',ORANGE,PEACH)]:
    rect(x,450,250,93,pale,radius=14)
    icon(x+63,495,.78,color,pale)
    text(x+111,487,caption,17,color,True)
arrow(284,495,294,495,MUTED); arrow(548,495,558,495,MUTED)
footer(1); c.showPage()

# 2. Different meanings; bounded disclosure; separately authorized action.
header('Meaning. Disclosure. Action.',2)
rect(32,113,342,120,MINT,radius=16); rect(468,113,342,120,LILAC,radius=16)
text(48,124,'Alice',12,TEAL,True); text(484,124,'Bob',12,PURPLE,True)
graph(110,178,.7,TEAL); graph(203,178,.7,TEAL)
line(130,166,182,166,TEAL,1.5,[3,4]); line(130,187,182,187,TEAL,1.5,[3,4])
text(286,170,'Ontology\nterms'.replace('\n',' '),12,TEAL,True,'center')
person(531,180,.9,PURPLE,LILAC); bot(632,178,.75,PURPLE,LILAC)
bidir(552,177,602,PURPLE)
# Thought dots identify the mental-model representation.
circle(539,151,2,PURPLE); circle(547,141,3,PURPLE)
text(735,165,'Mental model',12,PURPLE,True,'center')
rect(371,126,100,28,PAPER,radius=14); text(421,132,'alignment',12,INK,True,'center')
neq(421,188)

line(32,251,810,251,LINE,.8)
# A disclosure request with one selected field; the other fields stay local.
text(48,265,'Alice',12,TEAL,True)
for i,(caption,selected) in enumerate([('Summary',True),('Method',False),('Results',False),('Notes',False)]):
    checkbox(48,291+20*i,selected,caption)
arrow(168,324,274,324,TEAL)
circle(307,321,29,MINT); person(307,320,.78,TEAL,MINT)
text(307,362,'Approve',11,TEAL,True,'center')
arrow(342,324,445,324,TEAL)
envelope(490,323,.86,TEAL,MINT)
text(490,359,'Summary',11,TEAL,True,'center')
arrow(525,324,630,324,TEAL)
bot(691,321,.85,PURPLE,LILAC); receipt(763,321,.7,PURPLE,LILAC)
text(691,361,'Bob',11,PURPLE,True,'center')

line(32,390,810,390,LINE,.8)
# The second approval is not derived from the first one.
paper(91,463,.9,ORANGE); calendar(150,464,.52,ORANGE,PEACH)
text(122,509,'Booking',12,ORANGE,True,'center')
arrow(188,466,274,466,ORANGE)
circle(307,461,29,PEACH); person(307,460,.78,ORANGE,PEACH)
text(307,505,'New approval',11,ORANGE,True,'center')
arrow(342,466,436,466,ORANGE)
arrow(436,466,565,434,TEAL); arrow(436,466,565,510,ORANGE)
room(617,432,.63,TEAL,MINT); circle(644,419,12,MINT); tick(644,419,12,TEAL)
text(683,421,'Booked',13,TEAL,True)
paper(617,510,.52,ORANGE)
text(683,501,'Draft kept',13,ORANGE,True)
# Explicit alternative marks keep decline distinct from a technical failure.
tick(492,432,11,TEAL); cross(491,504,6,ORANGE)
footer(2); c.showPage()

# 3. A six-frame visual walkthrough. Keep exact control text only where useful.
header('Try it',3)
circle(744,66,12,WHITE,TEAL); line(744,66,744,58,TEAL); line(744,66,751,70,TEAL)
text(773,59,'3-5 min',10,MUTED)
xs=[32,296,560]; ys=[119,340]
for idx in range(6):
    xx=xs[idx%3]; yy=ys[idx//3]
    rect(xx,yy,250,198,WHITE,LINE,16)
    number(xx+19,yy+19,idx+1)
# 1. Fresh identity.
person(157,184,1.35,TEAL,MINT)
button(48,245,218,'Start a new visitor\nexperience',NAVY,11,42)
pointer(239,276,.65)
# 2. Guided, then scenario 03. Other task icons remain available.
rect(312,153,218,32,MINT,radius=7)
text(328,159,'Guided',13,TEAL,True)
line(507,167,512,172,TEAL); line(512,172,517,167,TEAL)
calendar(340,216,.5,TEAL,MINT); talk(413,216,.46,PURPLE,LILAC)
rect(463,186,56,58,PEACH,radius=9); discussion(491,215,.52,ORANGE,PEACH)
button(312,264,218,'Prepare a joint discussion',NAVY,10.5,32)
pointer(504,233,.65)
# 3. Field choice: neither approval nor refusal is presented as compulsory.
for i,(caption,selected) in enumerate([('Summary',True),('Method',False),('Results',False),('Notes',False)]):
    checkbox(578,156+22*i,selected,caption,size=12)
button(576,264,105,'Approve selected\nfields',TEAL,9.5,37)
button(689,264,105,'Decline this\nrequest',ORANGE,9.5,37)
# 4. Separate booking approval.
paper(128,408,.83,ORANGE); room(188,412,.48,ORANGE,PEACH)
text(157,451,'Booking',12,ORANGE,True,'center')
button(48,475,218,'Approve and continue booking',NAVY,10.3,32)
text(157,518,'or Decline this request',10.5,ORANGE,True,'center')
# 5. Permission is checked against actual reception in Bob's view.
rect(331,382,28,36,WHITE,TEAL,3,1.5); rect(469,382,28,36,WHITE,PURPLE,3,1.5)
line(340,391,353,391,TEAL,3); line(478,391,491,391,TEAL,3)
arrow(371,403,457,403,TEAL); tick(414,403,15,TEAL)
text(345,432,'Alice',11,TEAL,True,'center'); text(483,432,'Bob',11,PURPLE,True,'center')
text(414,455,'Summary',12,TEAL,True,'center')
text(414,471,'if approved',8,MUTED,False,'center')
button(312,484,218,'Inspect delivered information\nand receipts',NAVY,10.1,40)
# 6. Fresh visitor, retained old records.
receipt(615,405,.7,MUTED,PAPER); person(740,408,1.15,TEAL,MINT)
line(677,379,677,452,LINE,1.3,[3,3])
text(615,446,'Saved',10,MUTED,False,'center'); text(740,446,'New',10,TEAL,True,'center')
button(576,484,218,'Next visitor · new identity',NAVY,10.7,40)
# Reading direction is row-by-row rather than a misleading execution wire.
arrow(283,218,294,218,MUTED); arrow(547,218,558,218,MUTED)
arrow(283,439,294,439,MUTED); arrow(547,439,558,439,MUTED)
footer(3,True); c.showPage(); c.save()

reader=PdfReader(PATH)
assert len(reader.pages)==3
counts=[]
for i,page in enumerate(reader.pages,1):
    words=re.findall(r"\b[\w'-]+\b",page.extract_text())
    counts.append(len(words))
    assert len(words)<=95,(i,len(words))
    assert '\ufffd' not in page.extract_text()
for name,pages in [('symposium-project-interpretation-draft.pdf',range(2)),('symposium-visitor-guide-draft.pdf',[2])]:
    writer=PdfWriter()
    for i in pages: writer.add_page(reader.pages[i])
    writer.add_metadata({'/Title':'Agent on Request - '+('Visual project interpretation' if len(pages)==2 else 'Visual interaction guide'),'/Author':'Shiyao Zhang'})
    with (OUT/name).open('wb') as f: writer.write(f)
print({'pages':3,'words_per_page':counts,'previous_words':old_words,'current_words':sum(counts),'checked_text_placements':len(placements)})
print(PATH)
