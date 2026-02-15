/**
 * LLM Provider Abstraction for NanoClaw
 *
 * Defines the contract between the agent-runner main loop and any LLM backend.
 * Providers translate between this interface and their specific SDK.
 */

// ---------------------------------------------------------------------------
// Agent message types (emitted by providers during a query)
// ---------------------------------------------------------------------------

export interface AgentInitMessage {
  type: 'init';
  sessionId: string;
}

export interface AgentResultMessage {
  type: 'result';
  result: string | null;
  subtype?: string;
}

export interface AgentAssistantMessage {
  type: 'assistant';
  uuid?: string;
}

export interface AgentSystemMessage {
  type: 'system';
  subtype?: string;
  sessionId?: string;
  // task_notification fields (optional)
  task_id?: string;
  status?: string;
  summary?: string;
}

export type AgentMessage =
  | AgentInitMessage
  | AgentResultMessage
  | AgentAssistantMessage
  | AgentSystemMessage;

// ---------------------------------------------------------------------------
// Provider input
// ---------------------------------------------------------------------------

/**
 * A single user-turn pushed into the provider's prompt stream.
 */
export interface UserTurn {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

export interface AgentInput {
  /**
   * Either a static string (single-turn) or an async iterable of user turns
   * for multi-turn conversations (messages piped via IPC during a query).
   */
  prompt: AsyncIterable<UserTurn> | string;
  cwd: string;
  sessionId?: string;
  resumeAt?: string;
  systemPrompt?: string;
  env?: Record<string, string | undefined>;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  activeUser?: string;
  gmailEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface LLMProvider {
  /** Human-readable name for logging */
  readonly name: string;

  /**
   * Run an agentic query. Must yield AgentMessage events as the agent reasons
   * and acts. At minimum, should yield one AgentResultMessage with the final
   * answer.
   */
  query(input: AgentInput): AsyncIterable<AgentMessage>;

  /** Whether this provider supports session resume across container restarts */
  readonly supportsSessionResume: boolean;

  /** Whether this provider supports agent teams / sub-agents */
  readonly supportsAgentTeams: boolean;
}
