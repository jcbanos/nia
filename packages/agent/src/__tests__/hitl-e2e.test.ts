import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared refs – hoisted so vi.mock factories can capture them
// ---------------------------------------------------------------------------

const { indexRef, mockIssuesCreate } = vi.hoisted(() => ({
  indexRef: { current: 0 },
  mockIssuesCreate: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("octokit", () => ({
  Octokit: vi.fn(() => ({
    rest: {
      issues: { create: mockIssuesCreate },
      repos: { createForAuthenticatedUser: vi.fn() },
    },
  })),
}));

vi.mock("@agents/db", () => ({
  getSessionMessages: vi.fn(async () => []),
  addMessage: vi.fn(async () => undefined),
  createToolCall: vi.fn(async () => ({ id: "mock-tc-id" })),
  updateToolCallStatus: vi.fn(async () => undefined),
  getProfile: vi.fn(async () => ({})),
}));

/**
 * Replace the real model with a FakeToolCallingModel that:
 *   index 0 → proposes a github_create_issue tool call
 *   index 1 → returns plain text (no tool calls, ends the agent loop)
 *
 * `indexRef` is shared across model instances so the counter persists
 * even when buildConfiguredAgent creates a new model + bindTools copy.
 */
vi.mock("../model", async () => {
  const { FakeToolCallingModel } = await import("langchain");
  return {
    createChatModel: () =>
      new FakeToolCallingModel({
        toolCalls: [
          [
            {
              id: "call_1",
              name: "github_create_issue",
              args: {
                owner: "testowner",
                repo: "testrepo",
                title: "E2E Test Issue",
                body: "automated test",
              },
            },
          ],
          [],
        ],
        indexRef,
      }),
  };
});

// ---------------------------------------------------------------------------
// SUT – imported after mocks are wired
// ---------------------------------------------------------------------------

import { runAgent, resumeAgent } from "../graph";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HITL e2e – medium-risk tool interrupt → approve → agent sees result", () => {
  const SESSION_ID = "e2e-session";

  const shared = {
    userId: "user-1",
    sessionId: SESSION_ID,
    systemPrompt: "You are a test assistant.",
    db: {} as never,
    enabledTools: [
      {
        id: "ts-1",
        user_id: "user-1",
        tool_id: "github_create_issue",
        enabled: true,
        config_json: {},
      },
    ],
    integrations: [
      {
        id: "int-1",
        user_id: "user-1",
        provider: "github",
        scopes: ["repo"],
        status: "active" as const,
        created_at: new Date().toISOString(),
      },
    ],
    decryptedTokens: { github: "ghp_fake_token" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    indexRef.current = 0;
    mockIssuesCreate.mockResolvedValue({
      data: {
        number: 42,
        html_url: "https://github.com/testowner/testrepo/issues/42",
      },
    });
  });

  it("interrupts on medium-risk tool, resumes after approval, and agent sees tool result", async () => {
    // ── Step 1: trigger the medium-risk tool ──────────────────────────────
    const step1 = await runAgent({
      ...shared,
      message:
        "Create a GitHub issue titled E2E Test Issue in testowner/testrepo",
    });

    // The HITL middleware must interrupt before executing the tool
    expect(step1.interrupt).not.toBeNull();
    expect(step1.interrupt!.action_requests).toHaveLength(1);
    expect(step1.interrupt!.action_requests[0].name).toBe(
      "github_create_issue",
    );

    expect(step1.pendingConfirmation).not.toBeNull();
    expect(step1.pendingConfirmation!.tool_name).toBe("github_create_issue");
    expect(step1.pendingConfirmation!.args).toMatchObject({
      owner: "testowner",
      repo: "testrepo",
      title: "E2E Test Issue",
    });

    // The tool must NOT have been executed yet
    expect(mockIssuesCreate).not.toHaveBeenCalled();

    // ── Step 2: approve and resume ────────────────────────────────────────
    const step2 = await resumeAgent({
      ...shared,
      decisions: [{ type: "approve" }],
    });

    // The tool should now have been executed via the adapter → Octokit mock
    expect(mockIssuesCreate).toHaveBeenCalledTimes(1);
    expect(mockIssuesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "testowner",
        repo: "testrepo",
        title: "E2E Test Issue",
      }),
    );

    // No further interrupt – the agent finished its loop
    expect(step2.interrupt).toBeNull();
    expect(step2.pendingConfirmation).toBeNull();

    // The agent's final response must reference the tool output, proving
    // the LLM received the result and continued reasoning.
    expect(step2.response).toBeTruthy();
    expect(step2.response).toContain("42");
  });
});
