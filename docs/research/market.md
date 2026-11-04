# Agent-scriptable demo video: market research (2026-11-04)

Tags:
- **[read]**: taken from the vendor's own page, repository, registry or GitHub API today.
- **[secondary]**: a third-party page (review site, aggregator, press). Treat the number as approximate.
- **[inferred]**: my conclusion, not verified.

Terms follow the parallel technical file `capture.md` in this folder. That file was asked for as
`references.md`, which does not exist. It uses driver, capture, cursor overlay, composer and screencast.

Positioning tested throughout, as the owner set it: **"the demo-video tool your coding agent runs"**.
That means minimal or no UI. An agent writes the script, records, reviews, fixes, re-renders and
publishes, and a human only approves.

---

## 1. Verdict

**Do not build this as a paid product yet. It is worth building as an open-source (MIT) CLI with an
agent skill. Use it first on Max's own catalogs, then decide on money once outsiders use it.** [inferred]

The agent-runnable layer is crowded and almost free:
- **Free tools.** In October and November 2026 alone, at least eight MIT Playwright-to-demo-video tools
  were pushed to GitHub. Several ship Claude Code skills. The most mature is Argo: 111 stars, release
  v0.42.1 on 2026-10-27. Most of the rest have 0 to 3 stars. [read, §2]
- **Paid tools.** Tella already sells a hosted MCP server. An agent can film a web page with it
  (Auto Capture), edit, look at frames and publish to YouTube. The server is included on every plan
  from $13 per user per month. [read]
- **Playwright itself.** Playwright 1.64 has `page.screencast.showActions({ cursor })`,
  `showChapter` and `showOverlay` ([capture.md](./capture.md), read from the type definitions),
  so the base layer is absorbing the cursor overlay. [read]

**Wedge: verifiable, multilingual docs videos.** None of the tools I read combines all of these:
- **Separate capture and render.** The capture is recorded once with an event track. Camera, cursor,
  captions and voice are re-rendered from a timeline. [read: Argo does post-export zoom only; inferred
  for the rest]
- **Machine-checkable QA**, so an agent proves its own video is right without watching it. For example,
  "the cursor reached the target", "the caption was on screen while the click ran" and "the audio
  ends before the next step starts". [inferred: nobody offers assertions; contact sheets and validators
  exist, §2]
- **One script, N languages.** Per-language TTS tracks and caption files, plus silent web loops and
  vertical cuts from the same run. [inferred: nobody packages all of it]
- **Real gestures on WebKit and Safari.** Trackpad pinch, scroll and touch, not only Chromium clicks.
  [inferred]

**Who buys:**
- Maintainers of developer tools, UI kits and open-source libraries, and docs teams at
  developer-tool companies, who already keep Playwright tests and a Storybook.
- Individuals will not pay much. Docs teams pay $13–65 per seat for Tella, Guidde, Clueso and
  Descript (§5).

**Why now:**
- Coding agents ship UI faster than anyone can re-record videos.
- In 2026 every vendor in the field added an MCP server or an agent skill (§3).
- Playwright's screencast got good enough to build on: VP9 at CRF 8 in 1.64 (capture.md).

[inferred]

**Agent-operability gap, in one line.** End-to-end agent operation already exists, closed and
hosted in Tella and loose in many small OSS tools. What nobody has is a deterministic local pipeline
whose output the agent can check by assertion (event track, sync and frames) and re-render without
re-recording. [inferred]

---

## 2. Competitors and adjacent tools

Column "Agent E2E" asks one question: can an agent run the whole thing without a person in a GUI?

### 2.1 Screen recorders with auto-zoom (GUI-first)

| Tool | What it does | Agent E2E | Pricing | Licence, team, funding | Latest |
|---|---|---|---|---|---|
| **Screen Studio** | macOS recorder with auto zoom on clicks, smoothed cursor and motion blur. [read: [site](https://screen.studio/)] | **No.** No API, CLI or MCP. Deeplinks have no target parameters. An "agent-friendly / CLI" request was merged into another request, with no vendor reply. [read: [hub](https://hub.screen.studio/p/more-automation-and-agent-friendly)] | $9/mo yearly, $29/mo monthly, all features. Lifetime licences no longer sold. [read: [site](https://screen.studio/)] | Proprietary, macOS only, "no near-future plans for Windows". [read] Team and funding unknown. | v4.x (Product Hunt badge). Changelog page did not render. [read, partial] |
| **Cap** | Open-source Loom and Screen Studio alternative, desktop app plus self-hostable web. [read: [repo](https://github.com/CapSoftware/Cap)] | **Partly.** A Rust CLI in `apps/cli`, recorder and embed SDK packages, web API routes. No public API docs, no MCP. [read] | Free personal. Desktop Licence $29/yr or $58 lifetime. Pro $12/user/mo ($8.16 yearly). SSO $199/mo. [read: [pricing](https://cap.so/pricing)] | AGPLv3, some crates MIT. 24.3k stars. [read: GitHub API] Indie, about 5 people. [secondary: [startuphub](https://www.startuphub.ai/startups/cap.md)] No funding found. | cap-v0.6.2, 2026-10-28. [read: GitHub API] |
| **Cursorful** | Chrome extension and desktop app with automatic zoom and pan. [read: [site](https://cursorful.com/)] | **No.** No API or CLI. [read] | Free non-commercial. Pro $79 per seat one-time (launch price, normally $119). [read] | Proprietary. Team unknown. | Unknown ("V2 launch"). |
| **FocuSee** | Auto-zoom recorder by iMobie. | **No.** None found. [inferred] | Pricing page 404 today. | Proprietary. | Unknown. |
| **Rapidemo** | Windows auto-zoom recorder. Export needs a licence. [secondary: [gappsy](https://www.gappsy.com/tools/rapidemo/)] | **No.** [inferred] | Sources conflict: $9–19/mo or $59–199 one-time. [secondary] | Proprietary, Windows only. | Unknown. |
| **Tella** | Recorder and editor, now with a hosted MCP server. [read: [MCP docs](https://www.tella.com/docs/mcp-server.md)] | **Yes, closed and hosted.** MCP tools for zooms, mouse and key events, overlays, `apply_video_edits`, `get_video_frame`, `get_storyboard`, social publishing including YouTube, and **Auto Capture** ("Film a screen walkthrough of a web page with no one recording it"). Official skill, llms.txt, OAuth. [read] Auto Capture covers public web pages only, not desktop or mobile, and Tella does not create dubs. [read: [Tella blog, 2026-10-16](https://www.tella.com/blog/best-mcp-servers-for-video-editing)] | Pro $13/user/mo, Premium $19/user/mo (yearly). Auto Capture takes cost credits. Credit top-ups $25 per 25k credits. [read: [pricing](https://www.tella.com/pricing)] | Proprietary SaaS. Funding not checked. | Active in 2026-10. [read] |
| **Loom** | Async screen recording. | **No** public API or MCP on the pricing page. [read] | Free. Business $18/user/mo. Business + AI $24/user/mo. [read: [pricing](https://www.loom.com/pricing)] | Atlassian. | n/a |

### 2.2 Interactive demo platforms (GUI capture, MCP for reading and editing)

| Tool | Agent angle | Pricing | Funding | Notes |
|---|---|---|---|---|
| **Arcade** | No API or MCP on the pricing page. [read] Automated demo updates in beta. [secondary: [vidocu](https://vidocu.ai/blog/how-to-keep-tutorial-videos-up-to-date-when-the-ui-changes-every-sprint)] | Free (30 s, watermark). Pro $49/mo yearly, $59 monthly, up to 10 seats, 4K export. Credit slider up to $469/mo. [read: [pricing](https://www.arcade.software/pricing)] | $14M Series A led by Kleiner Perkins, Nov 2024. [secondary: [orrick](https://www.orrick.com/en/News/2024/11/Arcade-Completes-Series-A-Funding)] | Video export is free. |
| **Supademo** | MCP included from Scale up. [read] | Free. Scale $38–50 per creator. Business $199–249. Growth $350–450. [read: [pricing](https://supademo.com/pricing)] | Pre-seed (2048 Ventures). [secondary: CB Insights] | |
| **Storylane** | "Storylane MCP / Ask AI" from Starter. API on Enterprise. [read] | Free. Starter $40–50. Growth $500–625. Premium $1,200–1,500 per month. [read: [pricing](https://www.storylane.io/pricing)] | YC seed, about $1–2M. [secondary] | Multi-language demos on Premium. |
| **Navattic** | MCP server on Base and Growth. [read] | No public prices. [read: [pricing](https://www.navattic.com/pricing)] | $4.25M seed, 2022. [read: [blog](https://www.navattic.com/blog/building-the-future-of-plg)] | |
| **Walnut** | Sales-led. [secondary] | About $575/mo (Ignite, 3 seats). Sources conflict. [secondary: [trainn](https://trainn.co/blog/walnut-pricing/)] | | |
| **Reprise** | Sales-led. | Quote only. About $20–130k/yr. [secondary: [prospeo](https://prospeo.io/s/reprise-pricing-reviews-pros-and-cons)] | | |

These platforms target sales and marketing, not "video in CI". They are adjacent, not direct competitors. [inferred]

### 2.3 AI video and docs tools

| Tool | Agent angle | Pricing | Funding / scale |
|---|---|---|---|
| **Synthesia** | API, plus links to MCP docs. Avatars, 140+ languages. [read: [pricing](https://www.synthesia.io/pricing)] | Starter $14–19/mo (about 12 min). Pro $59–89/mo (about 60 min). [read] | $200M Series E at a $4B valuation, Jan 2026, $150M ARR. [secondary: [eweek](https://www.eweek.com/news/synthesia-january-2026-funding/), [Latham](https://www.lw.com/en/news/2026/01/latham-watkins-advises-synthesia-on-us200-million-series-e-and-secondary-transaction)] |
| **HeyGen** | API with a pay-as-you-go wallet. | About $1/min (Avatar III) to $3–6/min (Avatar IV/V). Figures conflict. [secondary: [anam](https://anam.ai/blog/heygen-pricing)] The official page did not render. | |
| **Descript** | "API + MCP" for editing "from inside your AI assistant". [read: [pricing](https://www.descript.com/pricing)] | $16–65 per person per month, priced in media hours and AI credits. [read] | |
| **Guidde** | MCP connector as an add-on, plus an "Agent Skill" export. [read: [pricing](https://www.guidde.com/pricing)] | Pro $19–29, Business $39–59 per creator. [read] | |
| **Scribe** | "Integrations, MCP & API" in the menu. Search API on Enterprise. [read: [pricing](https://scribe.com/pricing)] | Pro $25–35 per seat, Team $13–17 per seat (5 seats or more). [read] | |
| **Clueso** | "Clueso MCP" on every tier. GitHub-linked stale-video detection on Enterprise. [read: [pricing](https://www.clueso.io/pricing)] [secondary: vidocu] | Solo $40/mo (15 export minutes). Business $120/mo. [read] | YC. Sources conflict: $1.4–1.9M seed, or an unconfirmed $10M Series A. [secondary] |
| **Trupeer** | MCP row in the comparison table. Auto-updating documentation. [read: [pricing](https://www.trupeer.ai/pricing)] | Pro $40–49. Scale $199–249 per month. [read] | $3M seed, RTP Global, Jul 2025. [secondary: [natlawreview](https://natlawreview.com/press-releases/trupeerai-raises-3m-unlock-studio-quality-videos-every-software)] |
| **Videate** | "Connects at the code level", detects UI changes and re-renders videos. No API, CLI or MCP mentioned. [read: [site](https://www.videate.io/)] | Demo request only. [read] | Customer logos include Asana, Google and Bitsight. [read] |
| **Vidocu** | An "AI Recorder" agent replays a plain-language workflow in a real browser. API plus MCP. Pulse flags stale help articles, and regeneration is a manual click. [read: [blog, 2026-07-30](https://vidocu.ai/blog/how-to-keep-tutorial-videos-up-to-date-when-the-ui-changes-every-sprint)] | Not listed. | |
| **Motioneed** | Hosted MCP: `create_video` from a URL, `revise_video`, `share_video`. [read: [repo](https://github.com/motioneed/motioneed-mcp)] | Free plan: 10 s clips with a logo. Paid prices not shown. [read] | No licence. Last push 2026-11-01. [read] |
| **Clipy** | `@clipy/mcp` records headless Chromium and uploads it to Clipy. The CLI records the Mac screen. [secondary: [socket](https://socket.dev/npm/package/@clipy/mcp/overview/0.10.0)] | Not stated. | |

The "docs video from code" startups are Videate, Vidocu and Clueso's GitHub add-on. All three are
closed, SaaS and GUI-authored. None exposes the script as a file in the user's repository. [read/inferred]

### 2.4 Code-video infrastructure

| Tool | Agent angle | Pricing / licence | Latest |
|---|---|---|---|
| **Remotion** | Official Agent Skills: `npx skills add remotion-dev/skills` or `gh skill install`. Includes `/remotion-render`, `/remotion-captions` and `/remotion-license`. [read: [docs](https://www.remotion.dev/docs/ai/skills)] `@remotion/agent-plugin` ships with every release, and Studio has "agent-assisted quality improvements". [read: [releases](https://github.com/remotion-dev/remotion/releases)] `@remotion/mcp` only reads docs. [secondary: Tella blog] | Free for individuals, companies with up to 3 employees and non-profits. **Company Licence:** Creators $25 per seat per month, Automators $0.01 per render with a $100/mo minimum ("Automation developers don't need seats"), Enterprise from $500/mo. [read: [remotion.pro](https://www.remotion.pro/)] Forbids selling or relicensing a derivative. The licence "will slightly change" in 5.0. [read: [LICENSE.md](https://raw.githubusercontent.com/remotion-dev/remotion/main/LICENSE.md)] | v4.0.540, 2026-11-02. 70.5k stars. [read: GitHub API] |
| **Revideo** | Headless render API, CLI render endpoint. Engine behind Midrender. [read: [repo](https://github.com/redotvideo/revideo)] | MIT, 4.2k stars. [read] | `@revideo/core` 0.11.0, 2026-07-10 (capture.md). Last push 2026-07-15. [read] |
| **Motion Canvas** | Library and editor. | MIT, 19.7k stars. [read] | v3.17.2, 2024-12-14, effectively dormant. [read: GitHub API] |
| **Shotstack** | JSON render API, also has an MCP listing. [secondary: Tella blog] | $0.20/min pay-as-you-go. Plans $39/250 min (15.6¢), $99/750 (13.2¢), $199/2,000 (10¢), $499/10,000 (5¢). [read: [pricing](https://shotstack.io/pricing/)] | |

### 2.5 Playwright-based demo recorders and agent MCPs (the direct field)

Stars, licence and last push below are from the GitHub API today. [read]

| Project | What it does | Agent surface | Self-review | Stars / licence / latest |
|---|---|---|---|---|
| **Argo** [shreyaskarnik/argo](https://github.com/shreyaskarnik/argo), npm `@argo-video/cli` | Playwright script plus scenes manifest → MP4 with TTS (local Kokoro, OpenAI, ElevenLabs, Gemini…). Chromium, WebKit and Firefox. Cursor, post-export `zoomTo`, frames, backgrounds, 9:16 and 1:1, GIF, subtitles. [read] | CLI (`init/record/tts/export/pipeline/validate/preview/doctor`), Claude Code skill. No MCP. [read] | `argo validate` (no recording), `doctor`, scene report, subtitle files. Has a preview editor. [read] | 111 / MIT / v0.42.1, 2026-10-27. capture.md cites `lordrip/argo`, which is a fork. |
| **demowright** (npm) [snomiao/demowright](https://github.com/snomiao/demowright) | Playwright plugin: cursor, click ripples, keystroke badges, auto-slowdown, TTS, SRT. [read] | `--require demowright/register`. [read] | None found. | 2 / MIT / v2.8.0, 2026-04-27. Last push 2026-11-02. |
| **demowright** (unrelated, same name) [matte97p/demowright](https://github.com/matte97p/demowright) | Script in the repo, CI re-render, captions, cursor, zoom, scenes, social crops, TTS. [read] | CLI with `--dry-run` that prints the timeline. [read] | `frame-check.mjs` checks dropped frames on every PR. [read] | 3 / MIT / no release. Last push 2026-10-20. |
| **agent-video-recorder** [krav4enkodm](https://github.com/krav4enkodm/agent-video-recorder) | "Built for AI coding agents to run without manual editing". [read] | `avr record` returns **JSON**. Skill. No MCP. [read] | `avr contact-sheet` (PNG grid), `captureFps` in the result. [read] | 0 / MIT / v0.1.0, 2026-11-03. |
| **playwright-demo-video** [dxdleady](https://github.com/dxdleady/playwright-demo-video) | DOM zoom, coach marks, spotlight, 9:16. [read] | Agent Skill. [read] | Checks frames before handover; `snapshot()` and `assertRestored()` data guard. [read] | 0 / MIT / no release, 2026-10-22. |
| **autodemo** [mdayan8](https://github.com/mdayan8/autodemo) | Films an agent-driven tab, app, iOS Simulator or Android emulator via ScreenCaptureKit, or a Playwright script. [read] | **MCP server**: `camera_*`, `step`, `check`, `review`, `studio`. Claude Code plugin. [read] | `review` "renders, waits, checks every scene". [read] | 1 / MIT, 2026-10-24. |
| **Demo-Forge** [DixitRam](https://github.com/DixitRam/Demo-Forge) | Existing Playwright tests plus one narration line per step → MP4, using CDP screencast at 2×. [read: [daily.dev](https://daily.dev/posts/i-made-our-product-demo-videos-re-record-themselves-when-the-ui-changes-wjaimrq5f)] | CLI. | None found. | 48 / MIT, 2026-10-16. |
| **screenwright** [guidupuy](https://github.com/guidupuy/screenwright) | Playwright E2E → demo, Piper or OpenAI TTS. [secondary] | CLI. | None found. | 13 / MIT / v0.3.2, 2026-08-06. |
| **Playwright MCP** [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Browser driving for agents. Video capture flag has bugs (issue [#1093](https://github.com/microsoft/playwright-mcp/issues/1093)). | MCP. | | 39.1k / Apache-2.0 / v0.0.84, 2026-10-31. |
| **Playwright 1.64 `page.screencast`** | `showActions({ cursor })`, `showChapter`, `showOverlay`. [read: capture.md] | Library. | | Apache-2.0. |

---

## 3. Agent-facing surface: precedent and packaging

Four ways to package for agents exist in 2026. [read, inferred grouping]
1. **Skill plus local npm CLI.** Remotion, Argo, agent-video-recorder and playwright-demo-video.
   Distributed with `npx skills add` and `gh skill install`, or as a Claude Code plugin. Free, with
   money (if any) collected by a licence: Remotion Company Licence. [read]
2. **Hosted OAuth MCP.**
   - Tella: `api.tella.com/mcp`, included on all plans, credits for Auto Capture.
   - ElevenLabs archived its local `elevenlabs-mcp` (MIT, 1.5k stars, v0.12.2) in Aug 2026 in favour
     of a hosted MCP at `api.elevenlabs.io/v1/mcp` that draws on account credits.
     [read: [repo](https://github.com/elevenlabs/elevenlabs-mcp)]
   - Motioneed and Descript also host their MCP servers. [read]
3. **MCP as a plan feature.** Supademo, Storylane, Navattic, Clueso, Guidde (add-on) and Scribe.
   MCP is bundled into seats, never sold alone. [read]
4. **Local MCP wrapping a local tool.** autodemo, the DaVinci Resolve and Premiere MCPs, ffmpeg-mcp-lite.
   All free and open source. [read: Tella blog]

Consequence for Max: a local CLI plus a skill (and later a thin stdio MCP) is the norm for
developer-side tools. Hosted MCP is how SaaS vendors charge. [inferred]

### Closed-loop self-review: what exists

| Technique | Who offers it |
|---|---|
| Contact sheet or frame grabs | agent-video-recorder `contact-sheet`. Tella `get_video_frame`, `get_storyboard`, `get_video_preview`. playwright-demo-video "checks rendered frames". [read] |
| Config or timeline validation without recording | Argo `validate`, matte97p demowright `--dry-run`. [read] |
| Capture health metrics | agent-video-recorder `captureFps`. matte97p demowright `frame-check.mjs` dropped frames in CI. [read] |
| Transcript with word timings | Tella. [read] |
| Scene-level review | autodemo `review`. [read] |
| **Event-track assertions**: cursor at target when the click fired, caption visible during the action, narration fits its step, audio and caption drift under N ms | **None found.** [inferred] This is the clearest open piece. |

---

## 4. Gap analysis

Which pieces of the idea are already covered, and by whom:

| Piece of the idea | Covered by | Gap |
|---|---|---|
| Steps as code with narration per step | Argo (manifest), Demo-Forge, demowright, agent-video-recorder | Narration **per language** per step is not explicit in any of them. [inferred] |
| Hover, click and keystroke overlays | demowright (keystroke badges, ripples), Argo, Playwright `showActions` | Commodity. |
| Trackpad scroll and pinch, touch gestures | Not found in any recorder. capture.md shows CDP `synthesizeScrollGesture` works in Chromium. | **Open.** WebKit and Safari gestures especially. [inferred] |
| Real Chromium, Firefox and WebKit | Argo. | Safari through `safaridriver` is not covered. [inferred] |
| Native app or simulator capture | autodemo (ScreenCaptureKit, iOS Simulator), Tella (web only) | Partly covered, macOS only. |
| Clean viewport plus event track, re-rendered from a timeline | Argo zooms after export. Tella edits zooms from mouse events. [read] | **Partly open.** Nobody exposes an event track as a file the agent can edit and re-render. [inferred] |
| Camera leaving the viewport onto device frames and wallpaper | Argo (frames, backgrounds), Screen Studio (GUI) | Covered in part. |
| Captions and TTS per language | Argo, demowright (one language). Synthesia and HeyGen dub, but are closed. | **Multi-track output from one script is open.** |
| YouTube multi-audio and caption files | Tella publishes to YouTube, but has no dubbing. [read] | The Data API appears to have no audio-track upload (§6), so nobody can automate it fully. |
| Vertical Shorts | Argo, playwright-demo-video, matte97p demowright | Covered. |
| CI re-render when the UI changes | matte97p demowright, Demo-Forge, playwright-demo-video. Videate, Vidocu and Clueso as SaaS. | Covered in principle. Nobody pairs it with **assertions that fail the build**. |
| CLI, MCP and skills | Skills are everywhere. MCP: autodemo, Tella, Motioneed. | Covered. |
| Machine-checkable self-review | Contact sheets and validators (§3) | **Assertions are open.** |

**Closest three:**
1. **Argo.** The most complete open-source pipeline, with an agent skill, three engines, TTS and
   vertical output. Very active: v0.42 in 2026-10. [read]
2. **Tella MCP.** The most complete agent loop, end to end including publishing. Closed, hosted,
   web pages only, no dubbing. [read]
3. **agent-video-recorder and autodemo.** The same agent-first framing: JSON output and a contact
   sheet in one, MCP and native apps in the other. Both are days or weeks old. [read]

**Is "video as code, written by agents, re-rendered in CI" open or crowded?**
- The concept is crowded: at least 8 OSS projects plus 3–4 SaaS products.
- The quality bar is not. Almost all of the OSS projects have 0–111 stars, one maintainer and no
  QA story.
- The open space is the reliability layer: deterministic capture, assertions and multi-language
  output. [inferred]

---

## 5. Licence options

| Model | Who uses it | What it means for a solo developer |
|---|---|---|
| **MIT or Apache core + paid cloud renderer** | Revideo/Midrender (MIT engine, hosted product). Shotstack-style render APIs. [read] | Easiest adoption, and npm distribution just works. Revenue needs infrastructure: render farm, TTS proxy, billing. Anyone can fork the core and host it. Hosting means an on-call load Max does not have. [inferred] |
| **Copyleft core + paid commercial licence** | Cap: AGPLv3 core, $29/yr or $58 lifetime desktop licence, Pro cloud. [read] | AGPL scares companies off embedding it in CI, which pushes them to pay. That suits an app, but hurts a CLI that should sit in `devDependencies`. [inferred] |
| **Open core** (MIT CLI, closed Pro features) | Common in developer tools. Not checked in this field. | Needs feature gating and a licence-key check inside an npm package, which is easy to strip. [inferred] |
| **Source-available, free under a size threshold** (Remotion-style), or FSL/BSL | Remotion: free up to 3 employees, Company Licence $25/seat or $0.01/render with a $100 minimum, no reselling derivatives. 70.5k stars, so it scales. [read] FSL and BSL not checked for video tools. | Works through plain npm. Enforcement is by honour plus audits. Individuals and OSS stay free, which fits "adopt first". Support is filtered to paying companies. Forks are legally blocked from resale. [inferred] |
| **Paid desktop app** | Screen Studio $9–29/mo, Cursorful $79 once, Rapidemo. [read] | A GUI contradicts the no-UI positioning. macOS-only signing and notarisation, plus support for end users. [inferred] |

Two dependency notes. [read licence; inferred consequence]
- **Avoid depending on Remotion for the renderer.** Max's paying users with 4 or more employees would
  then also owe Remotion a licence, and Remotion forbids reselling derivatives.
- **ffmpeg** works if called as an external binary, which Argo and agent-video-recorder already do.

**Recommendation:**
- **Now:** MIT, published to public npm. That needs Max's explicit authorisation, because his
  repositories are private by default.
- **Later, if companies show up:** switch new major versions to a Remotion-style company licence, or
  sell a separate hosted MCP. Do not adopt AGPL or open core. [inferred]

---

## 6. Pricing benchmarks and suggested models

### Benchmarks from real pages

| Unit | Range | Examples |
|---|---|---|
| Per seat per month (docs and recording SaaS) | $8–65 | Cap Pro $8.16–12, Tella $13–19, Loom $18–24, Guidde $19–59, Scribe $13–35, Descript $16–65, Clueso $40–120 per account. [read] |
| Per seat per month (interactive demos) | $38–1,500 | Supademo $38–450, Storylane $40–1,500, Arcade $49–469. [read] |
| One-time desktop licence | $58–199 | Cap $58, Cursorful $79, Rapidemo $59–199 [secondary]. Screen Studio dropped lifetime. [read] |
| Per render | $0.01 | Remotion Automators, $100/mo minimum. [read] |
| Per rendered minute | $0.05–0.20 | Shotstack. [read] HeyGen avatars $1–6/min. [secondary] Synthesia about $1.2–1.6/min implied by plan minutes. [inferred from read] |
| TTS pass-through | $0.04–0.08 per 1k characters | ElevenLabs Flash/Turbo vs Multilingual v2/v3/v4. [read: [api pricing](https://elevenlabs.io/pricing/api)] OpenAI and Google pages not readable today. Kokoro local is free (Argo). |

### Three starting models

1. **Free MIT CLI and skill, then donations or consulting.** Revenue zero to low, maintenance lowest.
   Fits until adoption is proven. Recommended for the first 6–12 months. [inferred]
2. **Remotion-style company licence on the same npm package.** Free for individuals, OSS and
   companies with up to 3 employees. Companies pay:
   - "Automator" usage, which matches agent operation: about **$0.02–0.05 per rendered video**,
     with a **$29–49/mo minimum**;
   - or **$15–25 per human seat** for teams that also use a preview.

   Pricing by renders, not seats, fits a user that is an agent: Remotion's own line is "Automation
   developers don't need seats". [read for Remotion; inferred numbers]
3. **Hosted renderer and MCP with bring-your-own TTS key.** Charge per rendered minute,
   **$0.10–0.20/min** (Shotstack range), and pass TTS through at cost with the user's own
   ElevenLabs or OpenAI key. That keeps cost and abuse risk off Max. Only worth it once model 2 has
   paying users. Needs infrastructure and on-call. [inferred]

**Suggested: model 1 now, model 2 as the first paid step.** A team of 4 or more running per-render
billing in CI is the buyer who feels "docs videos never go stale" as saved time. [inferred]

---

## 7. Risks

### Platform risk [read where cited; inferred otherwise]

- **Playwright** already draws cursor, chapters and overlays (1.64). The next step, zoom or a
  narration track, would remove a lot of the commodity value.
- **Tella** already has agent recording, frames and YouTube publishing. Adding multi-language voice
  would cover most of the idea as a hosted service.
- **Remotion** has agent skills and per-render pricing. A `@remotion/screencast` package would compete
  directly.
- **Screen Studio** has an open request for a CLI and agent support, with no reply. It is macOS only.
- **Cap** has an AGPL CLI and recorder SDK packages already and could expose them.
- **Argo** ships about weekly and is the most likely OSS "winner".

### TTS cost pass-through [inferred from read prices]

- A 2-minute narration is about 300 words, or about 1,800 characters: about $0.07–0.15 per language
  per render on ElevenLabs.
- Ten languages cost about $1–1.50 per full regeneration. Caching unchanged lines by text hash makes
  CI re-renders nearly free. demowright already caches identical lines. [read]
- **Risk:** reselling TTS adds billing, fraud and ToS exposure. Bring-your-own key plus local Kokoro
  avoids it.

### macOS-only capture

- Headless Chromium screencast is capped at the CSS viewport size, so no Retina.
- `beginFrame` fails on macOS. True 2× needs ScreenCaptureKit with the Screen Recording permission,
  or Linux. [read: capture.md]
- Safari and native app capture need macOS and that permission, so they cannot run on Linux CI
  runners. Max's homelab runner is Linux. [inferred]

### YouTube API [read: [quota costs](https://developers.google.com/youtube/v3/determine_quota_cost), [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)]

- `videos.insert` has its own 100 calls per day.
- `captions.insert` costs 400 of the 10,000 units a day, so about 25 caption tracks a day by default.
- The docs state uploads from unverified projects are "not restricted to private viewing mode".
  [read]
- **Multi-language audio tracks appear to have no Data API endpoint.** Only YouTube Studio supports
  them. [secondary: [ytmla](https://github.com/cryptotech407/ytmla/releases), unconfirmed by Google]
  So "YouTube with multi-language audio" stays a manual or browser-automated step.

### What Max can maintain alone [inferred]

Realistic scope:
- a Chromium-first CLI, event track, renderer, assertions, captions and TTS adapters, and a skill;
- WebKit and Firefox best-effort.

Not realistic:
- a hosted render farm;
- a Safari, native app or mobile matrix;
- a GUI editor;
- support for paying companies on top of Sid-Kit, Data Grid and repo-kit.

Field speed is also a risk: Argo went to v0.42 within months, and this one person outpaced the rest.

---

## 8. Unknowns

- Funding and team size for Screen Studio, Tella, Cursorful, FocuSee, Guidde and Scribe. Not checked
  or not found.
- Clueso's $10M Series A (one aggregator, unconfirmed).
- Screen Studio's latest version and date: the changelog did not render.
- FocuSee prices (404). HeyGen official API rates (page did not render).
- OpenAI TTS (403) and Google Cloud TTS (no figures) prices.
- Navattic and Reprise prices (not public).
- How many Tella credits one Auto Capture take costs.
- Whether the YouTube Data API has any audio-track write path. Only a third-party claim says it does
  not.
- Download counts for Argo and the other tools (npm weekly downloads not fetched), so traction is
  judged by stars and release cadence only.
- Whether anyone pays for an OSS Playwright demo tool today. No paid tier exists in any project I
  read.
- Arcade API or MCP: search results were all Arcade.dev, an unrelated company.
