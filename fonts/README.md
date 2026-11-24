Noto Sans Symbols 2 supplies symbols the text fonts lack (arrows, media controls) for terminal export.
Bundled under the SIL Open Font License in `OFL.txt`.

Source: https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSansSymbols2
JetBrains Mono 2.304 supplies regular and bold text, matching Ghostty's default font.
It is bundled under the SIL Open Font License in `JetBrainsMono-OFL.txt`.
Source: https://github.com/JetBrains/JetBrainsMono/tree/v2.304/fonts/ttf

The exporter explicitly selects JetBrains Mono for text and Noto Sans Symbols 2 for missing symbols.

ScreenKitMono-{Regular,Bold}.ttf are derivatives of JetBrains Mono 2.304 under the
same SIL Open Font License (`JetBrainsMono-OFL.txt`), renamed to Screen Kit Mono.
U+25A0 has modified spacing: 5% side bearings keep compact bar cells visibly separate,
as in Ghostty's terminal symbol rendering. All text, bold faces, box drawing and
block elements retain the original geometry. U+E000 aliases the compact-square
outline; it is unused since terminal export stopped going through agg, and kept so
the files stay byte-identical. The default font is Screen Kit Mono.

Terminal export (`src/internal/terminal-raster.mjs`) reads these files itself
(`src/internal/truetype.mjs`), so every platform draws the same glyphs: a system
font renderer may ignore a font file it is handed and substitute another family.
Box drawing (U+2500–U+257F) and block elements (U+2580–U+259F, U+1FB82–U+1FB8B)
are not taken from any font: they are geometry snapped to each cell's whole pixels,
so borders and bars join without seams at any font size and line height.
Rebuild with `uv run --with fonttools python tools/build-symbol-font.py`.
