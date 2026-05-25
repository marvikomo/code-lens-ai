/**
 * Hardcoded fixture for langchainjs PR #10330:
 *   "fix(core): fix unit test failures for stream events, structured output
 *    parser, and tool call chunk merging"
 *
 * https://github.com/langchain-ai/langchainjs/pull/10330
 *
 * This is the static-prototype data the spatial canvas renders. Models 5 real
 * nodes from the actual diff plus 2 dependency nodes the reviewer would
 * naturally want to expand:
 *
 *   - Entry: runnable_stream_events_v2.test.ts (the failing test)
 *   - Fix: _mergeLists in base.ts (the actual change)
 *   - Related fix: AIMessageChunk.concat in ai.ts (type-cast cleanup)
 *   - Type: ToolCallChunk (referenced by both)
 *   - Test 2: structured.test.ts (other failing test, same PR)
 *
 * Edge confidence model matches the spec:
 *   - "ast"      → solid line (deterministically resolved)
 *   - "inferred" → dashed amber line (LLM hypothesis, with confidence)
 *   - "note"     → dotted gray (reviewer annotation; none in initial state)
 */

export type EdgeKind = "ast" | "inferred" | "note";

export interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
}

export interface SymbolNodeData {
  /** Unique node id, also used as React Flow node id. */
  id: string;
  /** Short symbol/function name shown in the header. */
  symbol: string;
  /** Repo-relative file path. */
  path: string;
  /** Line range in the post-PR file. */
  lineRange: [number, number];
  /** Whether this is an entry-point node (gets accent styling). */
  isEntryPoint: boolean;
  /** Diff hunk with surrounding context. Empty `removed` array = no removals. */
  diff: DiffLine[];
  /** AI-generated semantic summary; shown in the right pane on focus. */
  summary: string;
  /** Per-node risk flags from the AI layer. Empty = none flagged. */
  risks: string[];
  /** Verification mode for the node itself. */
  verification: "ast" | "inferred";
}

export interface CanvasEdgeData {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** Only set when kind === "inferred". */
  confidence?: number;
  /** Optional label hint shown on hover. */
  label?: string;
}

export interface PrFixture {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  baseCommit: string;
  headCommit: string;
  nodes: SymbolNodeData[];
  edges: CanvasEdgeData[];
  /** Recommended reading path — node ids in order, surfaced in the left sidebar. */
  readingPath: string[];
}

export const PR_10330: PrFixture = {
  owner: "langchain-ai",
  repo: "langchainjs",
  number: 10330,
  title:
    "fix(core): fix unit test failures for stream events, structured output parser, and tool call chunk merging",
  author: "hntrl",
  baseCommit: "f4a2c1d8e",
  headCommit: "26488b596",
  nodes: [
    {
      id: "test-stream-events-v2",
      symbol: "describe('streamEvents v2')",
      path: "libs/langchain-core/src/runnables/tests/runnable_stream_events_v2.test.ts",
      lineRange: [120, 160],
      isEntryPoint: true,
      verification: "ast",
      diff: [
        { kind: "context", text: "it('streams tool_call_chunks with empty id correctly', async () => {" },
        { kind: "context", text: "  const chunks: AIMessageChunk[] = [];" },
        { kind: "context", text: "  for await (const ev of model.streamEvents(input, { version: 'v2' })) {" },
        { kind: "context", text: "    if (ev.event === 'on_chat_model_stream') {" },
        { kind: "removed", text: "      chunks.push(ev.data.chunk);" },
        { kind: "added", text: "      chunks.push(ev.data.chunk as AIMessageChunk);" },
        { kind: "context", text: "    }" },
        { kind: "context", text: "  }" },
        { kind: "removed", text: "  expect(chunks[0].tool_call_chunks?.length).toBe(2);" },
        { kind: "added", text: "  // Merged chunks: empty-id pieces collapse instead of accumulating." },
        { kind: "added", text: "  expect(chunks[0].tool_call_chunks?.length).toBe(1);" },
        { kind: "context", text: "});" },
      ],
      summary:
        "Failing test for streamEvents v2 — was asserting that tool_call_chunks with empty IDs would accumulate as separate chunks. The fix changes that contract: empty-ID chunks now merge by index, matching the streaming-aggregation behavior of Python langchain.",
      risks: [],
    },
    {
      id: "test-structured-parser",
      symbol: "describe('StructuredOutputParser')",
      path: "libs/langchain-core/src/output_parsers/tests/structured.test.ts",
      lineRange: [42, 78],
      isEntryPoint: true,
      verification: "ast",
      diff: [
        { kind: "context", text: "it('parses streamed tool_call_chunks into structured output', async () => {" },
        { kind: "removed", text: "  expect(result.tool_calls).toHaveLength(2);" },
        { kind: "added", text: "  // After _mergeLists fix: empty-id chunks coalesce to one tool_call." },
        { kind: "added", text: "  expect(result.tool_calls).toHaveLength(1);" },
        { kind: "context", text: "});" },
      ],
      summary:
        "Same root cause as the streamEvents test — the structured output parser builds on top of message chunks, so the change in merge semantics propagates here. Tests had to be updated to expect 1 tool_call (post-merge) instead of 2 (pre-merge).",
      risks: [],
    },
    {
      id: "fn-merge-lists",
      symbol: "_mergeLists",
      path: "libs/langchain-core/src/messages/base.ts",
      lineRange: [553, 580],
      isEntryPoint: false,
      verification: "ast",
      diff: [
        { kind: "context", text: "export function _mergeLists<Content extends ContentBlock>(" },
        { kind: "context", text: "  ..." },
        { kind: "context", text: "  if (!hasMergeableIndex(leftItem)) return false;" },
        { kind: "context", text: "" },
        { kind: "context", text: "  const indiciesMatch = leftItem.index === item.index;" },
        { kind: "removed", text: "  const idsMatch =" },
        { kind: "removed", text: "    leftItem.id != null && item.id != null && leftItem.id === item.id;" },
        { kind: "removed", text: "  const eitherItemMissingID = leftItem.id == null || item.id == null;" },
        { kind: "added", text: "  const leftHasId = leftItem.id != null && leftItem.id !== \"\";" },
        { kind: "added", text: "  const rightHasId = item.id != null && item.id !== \"\";" },
        { kind: "added", text: "  const idsMatch = leftHasId && rightHasId && leftItem.id === item.id;" },
        { kind: "added", text: "  const eitherItemMissingID = !leftHasId || !rightHasId;" },
        { kind: "context", text: "  return indiciesMatch && (idsMatch || eitherItemMissingID);" },
        { kind: "context", text: "});" },
      ],
      summary:
        "The actual fix. Previously, empty-string IDs (\"\") were treated as 'has ID' — meaning streaming chunks like { id: '', index: 0 } would fail to merge with subsequent { id: '', index: 0 } chunks. The new logic treats \"\" as missing, matching Python langchain's behavior. Side effect: any callsite that depended on empty-string IDs being preserved through merge would silently break.",
      risks: [
        "Behavior change in a hot path (every streaming chat call). External callers depending on empty-string IDs surviving merge will break silently.",
      ],
    },
    {
      id: "fn-ai-message-chunk-concat",
      symbol: "AIMessageChunk.concat",
      path: "libs/langchain-core/src/messages/ai.ts",
      lineRange: [410, 425],
      isEntryPoint: false,
      verification: "ast",
      diff: [
        { kind: "context", text: "const rawToolCalls = _mergeLists(" },
        { kind: "context", text: "  this.tool_call_chunks as ContentBlock.Tools.ToolCallChunk[]," },
        { kind: "context", text: "  chunk.tool_call_chunks as ContentBlock.Tools.ToolCallChunk[]" },
        { kind: "context", text: ");" },
        { kind: "context", text: "if (rawToolCalls !== undefined && rawToolCalls.length > 0) {" },
        { kind: "removed", text: "  combinedFields.tool_call_chunks = rawToolCalls;" },
        { kind: "added", text: "  combinedFields.tool_call_chunks = rawToolCalls as ToolCallChunk[];" },
        { kind: "context", text: "}" },
      ],
      summary:
        "Single-line type cast added. `_mergeLists` returns `ContentBlock.Tools.ToolCallChunk[]` but the field expects the top-level `ToolCallChunk` type — structurally compatible, just needs the cast to satisfy strict mode. Cosmetic; no runtime behavior change.",
      risks: [],
    },
    {
      id: "type-tool-call-chunk",
      symbol: "ToolCallChunk",
      path: "libs/langchain-core/src/messages/tool.ts",
      lineRange: [12, 30],
      isEntryPoint: false,
      verification: "ast",
      diff: [
        { kind: "context", text: "// (not modified by this PR — referenced for context)" },
        { kind: "context", text: "export type ToolCallChunk = {" },
        { kind: "context", text: "  name?: string;" },
        { kind: "context", text: "  args?: string;" },
        { kind: "context", text: "  /** Empty string is now treated as 'no id' by _mergeLists. */" },
        { kind: "context", text: "  id?: string;" },
        { kind: "context", text: "  index?: number;" },
        { kind: "context", text: "  type?: 'tool_call_chunk';" },
        { kind: "context", text: "};" },
      ],
      summary:
        "The shared type referenced by both `_mergeLists` and `AIMessageChunk.concat`. Not modified by this PR but worth opening: confirms the `id` field is typed as optional string, so the new 'empty string = missing' contract is consistent with the type definition.",
      risks: [],
    },
    {
      id: "ai-suggested-is-base-message",
      symbol: "isBaseMessage (related cast?)",
      path: "libs/langchain-core/src/messages/base.ts",
      lineRange: [348, 362],
      isEntryPoint: false,
      verification: "inferred",
      diff: [
        { kind: "context", text: "static isInstance(obj: unknown): obj is BaseMessage {" },
        { kind: "context", text: "  return (" },
        { kind: "context", text: "    typeof obj === 'object' &&" },
        { kind: "context", text: "    obj !== null &&" },
        { kind: "context", text: "    MESSAGE_SYMBOL in obj &&" },
        { kind: "removed", text: "    obj[MESSAGE_SYMBOL] === true &&" },
        { kind: "added", text: "    (obj as Record<symbol, unknown>)[MESSAGE_SYMBOL] === true &&" },
        { kind: "context", text: "    isMessage(obj)" },
        { kind: "context", text: "  );" },
        { kind: "context", text: "}" },
      ],
      summary:
        "AI-inferred: this change in the same file looks related — also a strict-mode type cast. Likely bundled into the PR because the same TS strict pass surfaced both. Worth verifying it's actually safe (the cast assumes the symbol property exists, which the `in` check above guarantees).",
      risks: [
        "Type cast bypasses TS — verify the `in` check before it is sufficient guarantee.",
      ],
    },
  ],
  edges: [
    {
      id: "e-test-v2-to-merge",
      source: "test-stream-events-v2",
      target: "fn-merge-lists",
      kind: "ast",
      label: "asserts new merge behavior",
    },
    {
      id: "e-test-structured-to-merge",
      source: "test-structured-parser",
      target: "fn-merge-lists",
      kind: "ast",
      label: "transitively depends on merge semantics",
    },
    {
      id: "e-merge-to-concat",
      source: "fn-merge-lists",
      target: "fn-ai-message-chunk-concat",
      kind: "ast",
      label: "called by",
    },
    {
      id: "e-merge-to-type",
      source: "fn-merge-lists",
      target: "type-tool-call-chunk",
      kind: "ast",
      label: "operates on",
    },
    {
      id: "e-concat-to-type",
      source: "fn-ai-message-chunk-concat",
      target: "type-tool-call-chunk",
      kind: "ast",
      label: "casts to",
    },
    {
      id: "e-merge-to-isbase",
      source: "fn-merge-lists",
      target: "ai-suggested-is-base-message",
      kind: "inferred",
      confidence: 0.62,
      label: "same file, same TS strict pass?",
    },
  ],
  readingPath: [
    "test-stream-events-v2",
    "fn-merge-lists",
    "fn-ai-message-chunk-concat",
    "type-tool-call-chunk",
    "test-structured-parser",
    "ai-suggested-is-base-message",
  ],
};
