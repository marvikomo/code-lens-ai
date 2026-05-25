# spatial-review

**A spatial reading environment for code review.** Open a PR, see the changed
code as nodes on a canvas, click symbols to expand dependencies as new nodes.
The canvas grows as your mental model of the change deepens.

## What it does

Reviewing code well requires holding context the reviewer doesn't have
memorized — a function's contract, a type's shape, who else calls this thing,
what the surrounding error model expects. Senior engineers do this already:
jump to definition, hold the call site in working memory, trace a type, come
back, lose their place, scroll up.

spatial-review externalizes that process onto a persistent canvas. The
reviewer enters at the PR's entry point, sees relevant code as a node, and
**spawns new nodes by clicking symbols they need to understand**. The canvas
grows as their mental model of the change deepens.

The trigger for spawning a node is **unfamiliarity, not PR size.** A 1-file
PR that changes `auth.validate(token, { strict: false })` is a tiny diff —
but the questions the reviewer actually needs answered (what does `validate`
do with the strict flag? what shape is `token`? who else depends on
strict-true?) are invisible in the diff. Three node spawns from one line. The
same mechanism serves a 20-file refactor. PR size is a multiplier on the
pain, not the trigger.

It is **not** an AI PR reviewer. It does not auto-comment on lines or
summarize the diff. It sits alongside GitHub — the reviewer still comments,
approves, and merges there.

## The problem it solves

Reviewers default to one of two failure modes:

1. **Skim and approve.** They don't have the context to evaluate the change,
   so they look at it, see no obvious red flags, and approve. Bugs ship.
2. **Spelunk and lose the thread.** They open three editor tabs, jump to
   definitions, try to hold the call graph in working memory, lose their
   place, give up after 20 minutes of half-understanding.

Both are everyday occurrences, and both have measurable evidence:

- **Median PR review is 5–10 minutes** (most are skim-approves).
- **>500 LOC PRs take 3–4× longer AND get measurably less thorough reviews**
  (Microsoft Research / GitHub data). Sprawling diffs amplify the problem,
  but they aren't the root cause — the root cause is unfamiliar context.
- **Eye-tracking studies show reviewers re-read the same line 3–5×** on
  complex PRs — re-loading working memory each time they scroll back.
- **AI-generated PRs are by definition unfamiliar to the reviewer** (you
  wrote none of it). Verifying design intent costs more than verifying style.

The persistent canvas IS the memory aid: you can't lose your place if the
spatial layout *is* your place. The unfamiliar dependency stops being a
context tax and starts being a node you can refer back to.

## The trust mechanism (the differentiator)

The single most important UX principle: **AI output and AST output never look
the same.**

- **Solid line** = AST-verified (deterministic call / reference).
- **Dashed amber line** = AI-inferred relationship, with confidence score.
- **Verified badge** = AST. **AI-inferred badge** = LLM.

A reviewer who learns this language once trusts the tool more, not less, every
time the AI is wrong — because the tool was honest about which claim was
which. This is the moat: anyone can build a canvas; few commit to never
blurring inferred from observed.

## Non-goals

- Not a replacement for GitHub's PR page (reviewer still approves there).
- Not an AI PR reviewer in the CodeRabbit / Greptile sense (no auto-comments).
- Not a general codebase exploration tool (scope: one PR).
- Not a writing tool (the PR author is not the primary user).
- Not multi-reviewer, mobile, IDE-integrated, or stacked-PR-aware (yet).

## Who it's for

Anyone reviewing code they don't have memorized — which is approximately every
PR touching code outside the small surface area you wrote yourself recently.
Concretely:

- **Cross-team PRs** — you don't own the code being changed.
- **PRs from new contributors** — you don't know their patterns or intent.
- **PRs in unfamiliar services** even if you "own" the broader system.
- **AI-generated PRs** — by definition, you wrote none of it.
- **Your own old PRs from 6 months ago** — you've forgotten the shape.

A 1-file PR with one opaque dependency call is in scope. A 20-file refactor is
in scope. The mechanism is the same; PR size only changes the volume of
spawns you'll do.

---

## Prototype status

This directory contains a **Step 1 prototype**: spatial canvas with no
backend, no analyzer, no AI. The fixture is **real data** from langchainjs PR
[#10330](https://github.com/langchain-ai/langchainjs/pull/10330) ("fix(core):
fix unit test failures for stream events, structured output parser, and tool
call chunk merging"). All node code blocks are exact diff hunks from the PR.

Goal: validate the spatial reading interaction before building anything else.
What does the canvas *feel* like with realistic data? Where does the layout
break? What's the gap between "spec text" and "thing on a screen"?

## Run

```bash
cd apps/spatial-review
npm install
npm run dev
```

Open http://localhost:3000.

## What's here

- **6 nodes** modeled on PR #10330: 2 test entry points (blue accent), 2
  production-code changes, 1 type reference, 1 AI-inferred related cast.
- **6 edges**, 5 AST-verified (solid gray) + 1 AI-inferred (dashed amber, 62%
  confidence).
- **3-pane layout**: reading-path sidebar, canvas, focus pane.
- **Diff rendering**: green/red gutters, strike-through on removals,
  surrounding context.
- **Trust-by-visual**: solid = AST, dashed = AI, no exceptions.

## What's NOT here (deliberate)

- No backend. Data is hardcoded in [lib/fixtures/pr-10330.ts](lib/fixtures/pr-10330.ts).
- No URL input. Single fixture only — this is Step 1 of [the build spec](../../README.md#spatial-pr-review).
- No symbol-click-to-spawn. Click selects + focuses the right pane; spawning
  new nodes requires the analyzer wired up (Step 2).
- No persistence. Refresh resets focus.
- No GitHub auth, no OAuth, no comment posting.
- No LLM. The "summary" and "risk flag" text on each node was hand-written based
  on actual reading of the PR; in production it'd come from the LLM.

## Design decisions worth flagging

1. **Hand-tuned layout, not auto-layout.** Step 1 just hardcodes positions
   ([components/SpatialCanvas.tsx](components/SpatialCanvas.tsx)). Auto-layout
   (dagre, elk) lands when we know what shape the canvas actually wants.

2. **Node sizing is fixed at 420px wide.** Too wide and you can't fit four on
   screen; too narrow and the diff text wraps illegibly. 420 was eyeballed.

3. **Diff body is scrollable inside the node, capped at 280px tall.** Long
   functions don't blow up the canvas. The "expand" affordance from the spec is
   not built yet.

4. **AI-inferred nodes use the same card shape, distinguished only by border
   style + background tint.** The spec says they should be a "distinct node
   type" — I read that as visual treatment, not structural. Revisit if user
   testing shows the distinction is too subtle.

5. **No edge labels by default.** Edges have label text in the fixture
   (`"called by"`, `"asserts new merge behavior"`) but they're hidden until
   xyflow displays them — currently visible as overlays. Tweak in next pass if
   they add too much noise.

## Files

- [package.json](package.json) — deps + scripts
- [app/page.tsx](app/page.tsx) — Next.js entry, renders the canvas
- [components/SpatialCanvas.tsx](components/SpatialCanvas.tsx) — xyflow + 3-pane layout
- [components/SymbolNode.tsx](components/SymbolNode.tsx) — the per-symbol card
- [lib/fixtures/pr-10330.ts](lib/fixtures/pr-10330.ts) — the hardcoded PR data
- [app/globals.css](app/globals.css) — all styling (no Tailwind for prototype)

## Next steps

If the interaction feels right, Step 2 is "wire to the analyzer end-to-end on
one real PR." That requires building 3 analyzer APIs we don't have yet (see
the build spec). If the interaction feels wrong, iterate the design here
before any of that work.
