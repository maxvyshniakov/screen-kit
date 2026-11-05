Noto Sans Symbols 2 supplies the legacy-computing slot glyph (U+1FB85) for screenshot export.
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
outline. Export uses this alias in a derived render take because agg's swash
backend synthesizes U+25A0; the original captured take remains unchanged.
Swash renders block elements against the cell grid, preventing vertical seams
at font sizes with fractional cell widths. The default font is Screen Kit Mono;
custom font lists retain it as fallback for the alias. Rebuild with
`uv run --with fonttools python tools/build-symbol-font.py`.
