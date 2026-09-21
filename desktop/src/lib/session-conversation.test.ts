import { describe, expect, it } from "vitest";
import { buildConversation, buildSessionConversation, countTurnPatches, classifyExploration, sanitizeProcessText, summarizeOutput, type ReplayItem } from "./session-conversation";
import type { SessionReplayDetail } from "./api";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("process text sanitizer", () => {
  // Task #84: only stdout went through cleanExecOutput, so a failing CLI's stderr
  // was pasted into the red block with its escape sequences and control bytes.
  it("removes the bytes that cannot be shown as text without rewriting the message", () => {
    expect(sanitizeProcessText(`${ESC}[31merror${ESC}[0m: no such file`)).toBe("error: no such file");
    expect(sanitizeProcessText(`first line${BEL}still the first line`)).toBe("first linestill the first line");
    expect(sanitizeProcessText("kept\ttab and\nnewline")).toBe("kept\ttab and\nnewline");
  });

  it("turns carriage returns into line breaks so later text cannot overwrite earlier text", () => {
    expect(sanitizeProcessText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("keeps an absent stream absent instead of inventing empty output", () => {
    expect(sanitizeProcessText(null)).toBeNull();
    expect(sanitizeProcessText(undefined)).toBeNull();
    expect(sanitizeProcessText("")).toBe("");
  });
});

function replayTurn(items: ReplayItem[]): SessionReplayDetail["turns"][number] {
  return { turnId: "1", startedAt: null, completedAt: null, durationMs: null, systemMessages: [], userMessages: [], assistantMessages: [], reasoningSummaries: [], toolCalls: [], patchResults: [], tokenEvents: [], errors: [], items };
}
function command(cmd: string, overrides: Partial<Extract<ReplayItem, { kind: "toolCall" }>> = {}): ReplayItem {
  return { kind: "toolCall", callId: cmd, name: "exec_command", arguments: JSON.stringify({ cmd }), output: JSON.stringify({ exit_code: 0, output: "result" }), stderr: null, startedAt: null, completedAt: "2026-09-09", durationMs: 100, status: "completed", isError: false, ...overrides };
}
function usage(totalTokens: number, model = "gpt-5"): ReplayItem {
  return { kind: "tokenUsage", timestamp: null, model, inputTokens: totalTokens - 10, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens };
}

describe("conversation projection", () => {
  it("counts direct and nested patches without counting mirrored legacy results twice", () => {
    const patch = "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch";
    const direct = command("", { name: "functions.apply_patch", callId: "direct", arguments: patch });
    const mirror: ReplayItem = { kind: "patch", callId: "direct", success: true, isError: false, output: "ok", timestamp: null };
    const nested = command("", { name: "exec", callId: "nested", arguments: `text(await tools.apply_patch(${JSON.stringify(patch)})); text(await tools.apply_patch(${JSON.stringify(patch)}));` });
    expect(countTurnPatches(replayTurn([direct, mirror, nested]))).toBe(3);
    expect(countTurnPatches(replayTurn([mirror, direct, nested]))).toBe(3);
    expect(countTurnPatches(replayTurn([mirror]))).toBe(1);
    expect(countTurnPatches(replayTurn([command("echo apply_patch")]))).toBe(0);
    expect(countTurnPatches(replayTurn([command("", { name: "exec", arguments: 'text("tools.apply_patch(example)");' })]))).toBe(0);
  });

  it("groups adjacent exploration without losing calls, raw provenance or token attribution", () => {
    const blocks = buildConversation(replayTurn([
      command("rg -n shimmer src", { rawJsonlLineNumbers: [1, 2] }), usage(100),
      command("cat src/a.rs"), usage(200), command("cat src/a.rs src/b.rs"), usage(300),
      { kind: "message", role: "assistant", text: "Next", source: "message", timestamp: null },
      command("ls src"), usage(400),
    ]));
    expect(blocks.map((block) => block.kind)).toEqual(["exploration", "item", "exploration"]);
    const first = blocks[0];
    if (first.kind !== "exploration") throw new Error("Expected exploration");
    expect(first.entries.map((entry) => entry.tokenUsage?.totalTokens)).toEqual([100, 200, 300]);
    expect(first.entries[0].item.rawJsonlLineNumbers).toEqual([1, 2]);
    expect(first.actions[0]).toEqual([{ label: "Search", text: "shimmer in src" }]);
  });

  it("displays every request's own token volume without differencing across turns", () => {
    const conversations = buildSessionConversation([
      replayTurn([command("cat a"), usage(100)]),
      replayTurn([command("cat b"), usage(130)]),
    ]);

    expect(conversations[0][0].kind === "exploration" && conversations[0][0].entries[0].tokenUsage?.totalTokens).toBe(100);
    expect(conversations[1][0].kind === "exploration" && conversations[1][0].entries[0].tokenUsage?.totalTokens).toBe(130);
  });

  // Same fixture as `calculates_token_deltas_from_running_totals` in
  // session_replay.rs: the backend already emits per-request amounts, so a
  // second, smaller request must never render as a negative step.
  it("keeps a shrinking request positive, matching the Rust per-request contract", () => {
    const blocks = buildConversation(replayTurn([command("cat a"), usage(150), command("cat b"), usage(120)]));
    const volumes = blocks.flatMap((block) => (block.kind === "exploration"
      ? block.entries.map((entry) => entry.tokenUsage?.totalTokens ?? null)
      : [block.entry.tokenUsage?.totalTokens ?? null]));

    expect(volumes).toEqual([150, 120]);
    expect(volumes.every((volume) => volume === null || volume >= 0)).toBe(true);
  });

  it("keeps failures, running commands, writes and ambiguous shell scripts visible", () => {
    const blocks = buildConversation(replayTurn([
      command("cat a", { isError: true }), command("cat a", { status: "running" }),
      command("cat a", { output: JSON.stringify({ exit_code: 2, output: "no file" }) }),
      command("cat a && pnpm test"), command("cat a&&pnpm test"), command("cat a > b"),
      command("cat a | sh"), command("cat $(touch x)"), command("cat a &"), command("cat 'unterminated"),
    ]));
    expect(blocks.every((block) => block.kind === "item")).toBe(true);
  });

  it("does not present the first command of an unpaired batch as exploration", () => {
    const blocks = buildConversation(replayTurn([command("", {
      name: "exec", arguments: 'text(await tools.exec_command({cmd:"cat a"})); text(await tools.exec_command({cmd:"pnpm test"}));',
    }), usage(500)]));
    expect(blocks[0].kind).toBe("item");
  });

  it("projects nested commands, patches and images in source order", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-tools.view_image({path: 'not a call'})\n+fixed\n*** End Patch";
    const argumentsJson = [
      'text(await tools.exec_command({cmd:"pnpm test", workdir:"/repo"}));',
      `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`,
      'const image = await tools.view_image({path:"/tmp/result.png"}); image(image.image_url);',
      'text(await tools.exec_command({cmd:"git status --short"}));',
    ].join("\n");
    const output = JSON.stringify([
      { type: "input_text", text: JSON.stringify({ exit_code: 0, output: "tests passed", wall_time_seconds: 1.2 }) },
      { type: "input_text", text: "Done!" },
      { type: "image", image_url: "data:image/png;base64,AA==" },
      { type: "input_text", text: JSON.stringify({ exit_code: 0, output: "M src/a.ts", wall_time_seconds: 0.1 }) },
    ]);
    const block = buildConversation(replayTurn([command("", { name: "exec", arguments: argumentsJson, output })]))[0];
    if (block.kind !== "item" || block.entry.item.kind !== "toolCall") throw new Error("Expected tool activity");
    expect(block.entry.activity?.nestedActivities).toEqual([
      { kind: "command", command: "pnpm test", workdir: "/repo", output: { stdout: "tests passed", stderr: null, exitCode: 0, wallTimeSeconds: 1.2, sessionId: null } },
      { kind: "patch", patch },
      { kind: "image", path: "/tmp/result.png", imageUrl: "data:image/png;base64,AA==" },
      { kind: "command", command: "git status --short", workdir: null, output: { stdout: "M src/a.ts", stderr: null, exitCode: 0, wallTimeSeconds: 0.1, sessionId: null } },
    ]);
  });

  it("stops attributing nested exec outputs once a call cannot be paired", () => {
    const argumentsJson = [
      'text(await tools.exec_command({workdir:"/x"}));',
      'text(await tools.exec_command({cmd:"pnpm test"}));',
      'text(await tools.exec_command({cmd:"git status --short"}));',
    ].join(" ");
    const nested = (output: string) => {
      const block = buildConversation(replayTurn([command("", { name: "exec", arguments: argumentsJson, output })]))[0];
      if (block.kind !== "item" || block.entry.item.kind !== "toolCall") throw new Error("Expected tool activity");
      return block.entry.activity?.nestedActivities ?? [];
    };
    const results = (texts: string[]) => JSON.stringify(texts.map((text) => ({ type: "input_text", text })));

    // Before the fix the second and third commands inherited the first result and
    // its successor, so every command displayed another command's output.
    expect(nested(results([
      JSON.stringify({ exit_code: 1, output: "first call noise" }),
      JSON.stringify({ exit_code: 0, output: "tests passed" }),
      JSON.stringify({ exit_code: 0, output: "M src/a.ts" }),
    ]))).toEqual([
      { kind: "command", command: "pnpm test", workdir: null, output: null },
      { kind: "command", command: "git status --short", workdir: null, output: null },
    ]);
    expect(nested(results([
      JSON.stringify({ exit_code: 0, output: "M src/a.ts" }),
      JSON.stringify({ exit_code: 0, output: "tests passed" }),
    ]))).toEqual([
      { kind: "command", command: "pnpm test", workdir: null, output: null },
      { kind: "command", command: "git status --short", workdir: null, output: null },
    ]);
  });

  it("folds adjacent usage events of the same model instead of dropping one", () => {
    const blocks = buildConversation(replayTurn([command("cat a"), usage(100), usage(130)]));
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== "exploration") throw new Error("Expected exploration");
    expect(blocks[0].entries).toHaveLength(1);
    expect(blocks[0].entries[0].tokenUsage?.totalTokens).toBe(230);
    expect(blocks[0].entries[0].tokenUsage?.inputTokens).toBe(210);
    expect(blocks[0].entries[0].tokenUsage?.outputTokens).toBe(20);
  });

  it("keeps adjacent usage events of different models as separate visible entries", () => {
    const blocks = buildConversation(replayTurn([
      command("cat a"), usage(100, "gpt-5"), usage(30, "claude-sonnet-4.5"),
    ]));
    const volumes = blocks.flatMap((block) => (block.kind === "exploration"
      ? block.entries.map((entry) => entry.tokenUsage?.totalTokens ?? null)
      : [block.entry.tokenUsage?.totalTokens ?? (block.entry.item.kind === "tokenUsage" ? block.entry.item.totalTokens : null)]));

    expect(volumes).toEqual([100, 30]);
  });

  it("recognizes literal RTK read, search and list commands", () => {
    expect(classifyExploration("rtk proxy cat 'src/a b.rs'")).toEqual([{ label: "Read", text: "src/a b.rs" }]);
    expect(classifyExploration("rtk sed -n '1,20p' src/a.rs")).toEqual([{ label: "Read", text: "src/a.rs" }]);
    expect(classifyExploration("rg --files src")?.[0].label).toBe("List");
    expect(classifyExploration("rtk proxy sh -c 'cat src/a.rs && ls src'")).toEqual([
      { label: "Read", text: "src/a.rs" }, { label: "List", text: "src" },
    ]);
    expect(classifyExploration("rg '(shimmer|status)' src")?.[0].label).toBe("Search");
    expect(classifyExploration("sed -i 's/a/b/' src/a.rs")).toBeNull();
  });

  it("keeps the head and tail with an exact omitted line count", () => {
    expect(summarizeOutput("1\n2\n3\n4\n5\n6\n7\n8")).toEqual({ head: ["1", "2", "3"], tail: ["7", "8"], omitted: 3 });
    expect(summarizeOutput("1\n2")).toEqual({ head: ["1", "2"], tail: [], omitted: 0 });
  });
});
