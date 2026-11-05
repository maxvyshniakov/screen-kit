#!/usr/bin/env python3
"""uv run --with fonttools python tools/build-symbol-font.py

JetBrains Mono derivatives: compact square side bearings and a font-rendered alias for agg.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen

root=Path(__file__).resolve().parents[1]
for style in ('Regular','Bold'):
    font=TTFont(root/f'fonts/JetBrainsMono-{style}.ttf')
    glyph=font.getBestCmap()[0x25A0]
    pen=TTGlyphPen(font.getGlyphSet())
    font.getGlyphSet()[glyph].draw(TransformPen(pen,(.9,0,0,1,30,0)))
    font['glyf'][glyph]=pen.glyph()
    font['hmtx'][glyph]=(600,30)
    # agg's swash renderer synthesizes U+25A0 as a solid cell. The private-use
    # alias preserves the actual compact-square outline while blocks remain synthetic.
    for table in font['cmap'].tables:
        if table.isUnicode():
            table.cmap[0xE000]=glyph
    for record in font['name'].names:
        if record.nameID in (1,16):value='Screen Kit Mono'
        elif record.nameID in (3,4):value=f'Screen Kit Mono {style}'
        elif record.nameID==6:value=f'ScreenKitMono-{style}'
        elif record.nameID in (2,17):value=style
        else:continue
        record.string=value.encode(record.getEncoding())
    font.save(root/f'fonts/ScreenKitMono-{style}.ttf')
