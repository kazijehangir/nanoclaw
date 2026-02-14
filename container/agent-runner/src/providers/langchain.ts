/**
 * LangChain Provider for NanoClaw
 *
 * Uses LangChain's createReactAgent (from @langchain/langgraph) to run an
 * agentic loop with tool calling. Supports multiple model backends:
 *   - Gemini via @langchain/google-genai
 *   - OpenAI-compatible (LMStudio, Ollama, etc.) via @langchain/openai
 *   - OpenAI native via @langchain/openai
 *
 * Configuration via environment variables:
 *   LLM_MODEL     — model name (default: gemini-2.0-flash)
 *   LLM_API_KEY   — API key for the model provider
 *   LLM_BASE_URL  — base URL for OpenAI-compatible endpoints
 */

import fs from 'fs';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import type { LLMProvider, AgentInput, AgentMessage, UserTurn } from './types.js';
import { buildAllTools } from './tools.js';

function log(message: string): void {
    console.error(`[langchain-provider] ${message}`);
}

// ---------------------------------------------------------------------------
// LLM factory
// ---------------------------------------------------------------------------

function createLLM(env: Record<string, string | undefined>): BaseChatModel {
    const model = env.LLM_MODEL || 'gemini-2.0-flash';
    const baseUrl = env.LLM_BASE_URL;
    const apiKey = env.LLM_API_KEY || env.GOOGLE_API_KEY;

    if (baseUrl) {
        // OpenAI-compatible endpoint (LMStudio, Ollama, vLLM, etc.)
        log(`Using OpenAI-compatible endpoint: ${baseUrl}, model: ${model}`);
        return new ChatOpenAI({
            modelName: model,
            configuration: { baseURL: baseUrl },
            apiKey: apiKey || 'not-needed',
            temperature: 0.7,
        });
    }

    if (model.startsWith('gemini')) {
        log(`Using Google Gemini: ${model}`);
        if (!apiKey) {
            throw new Error('LLM_API_KEY or GOOGLE_API_KEY is required for Gemini models');
        }
        return new ChatGoogleGenerativeAI({
            model,
            apiKey,
            temperature: 0.7,
        });
    }

    // Default: OpenAI
    log(`Using OpenAI: ${model}`);
    if (!apiKey) {
        throw new Error('LLM_API_KEY is required for OpenAI models');
    }
    return new ChatOpenAI({
        modelName: model,
        apiKey,
        temperature: 0.7,
    });
}

// ---------------------------------------------------------------------------
// LangChainProvider
// ---------------------------------------------------------------------------

export class LangChainProvider implements LLMProvider {
    readonly name = 'langchain';
    readonly supportsSessionResume = false;
    readonly supportsAgentTeams = false;

    async *query(input: AgentInput): AsyncIterable<AgentMessage> {
        const env = input.env || {};

        // Create the LLM
        const llm = createLLM(env);

        // Build tools
        const tools = buildAllTools(
            input.cwd,
            input.chatJid,
            input.groupFolder,
            input.isMain,
            input.activeUser,
        );

        // Load system prompt
        const systemPromptParts: string[] = [];

        // Load CLAUDE.md (works as a general system prompt for any model)
        const claudeMdPath = `${input.cwd}/CLAUDE.md`;
        if (fs.existsSync(claudeMdPath)) {
            systemPromptParts.push(fs.readFileSync(claudeMdPath, 'utf-8'));
        }

        // Load global CLAUDE.md for non-main groups
        const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
        if (!input.isMain && fs.existsSync(globalClaudeMdPath)) {
            systemPromptParts.push(fs.readFileSync(globalClaudeMdPath, 'utf-8'));
        }

        // Append custom system prompt if provided
        if (input.systemPrompt) {
            systemPromptParts.push(input.systemPrompt);
        }

        // Load user-specific memory
        if (input.activeUser) {
            const safeUser = input.activeUser.replace(/[^a-zA-Z0-9-]/g, '_');
            const userMemoryPath = `${input.cwd}/users/${safeUser}/CLAUDE.md`;
            if (fs.existsSync(userMemoryPath)) {
                systemPromptParts.push(`USER MEMORY (${input.activeUser}):\n${fs.readFileSync(userMemoryPath, 'utf-8')}`);
            }
        }

        // Base instructions for the agent
        systemPromptParts.unshift(
            'You are a helpful AI assistant. You have access to tools for file operations, ' +
            'running bash commands, fetching web content, and managing tasks.\n\n' +
            'CRITICAL TOOL USAGE RULES:\n' +
            '1. REMINDERS & CHORES: You MUST use the `schedule_task` tool to set reminders or schedule jobs. ' +
            'Do NOT just saying "I\'ll remember to do that" — if you don\'t call `schedule_task`, nothing will happen.\n' +
            '2. CHECKING TASKS: To see what is scheduled, use `list_tasks`.\n' +
            '3. PERSISTENT MEMORY: To remember information permanently (user preferences, facts, etc.), ' +
            'you MUST use the `update_memory` tool. Do NOT write to temporary files like `/tmp/` ' +
            'or try to edit files manually for memory.\n' +
            '4. Use other tools (bash, read_file, etc.) as needed to accomplish the user\'s request.\n' +
            'When you\'re done, provide a clear, concise response to the user.',
        );

        const systemPrompt = systemPromptParts.join('\n\n---\n\n');

        // Create the ReAct agent
        const agent = createReactAgent({
            llm,
            tools,
            prompt: systemPrompt,
        });

        // Emit a synthetic init message
        yield { type: 'init', sessionId: `langchain-${Date.now()}` };

        // Process messages from the prompt stream
        const processPrompt = async (text: string): Promise<AgentMessage | null> => {
            try {
                log(`Invoking agent with prompt (${text.length} chars)`);

                const result = await agent.invoke(
                    { messages: [{ role: 'user', content: text }] },
                );

                // Extract the final assistant message
                const messages = result.messages || [];
                const lastMessage = messages[messages.length - 1];
                const responseText = lastMessage?.content
                    ? typeof lastMessage.content === 'string'
                        ? lastMessage.content
                        : JSON.stringify(lastMessage.content)
                    : null;

                if (responseText) {
                    log(`Agent response: ${responseText.slice(0, 200)}`);
                }

                return {
                    type: 'result',
                    result: responseText,
                };
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                log(`Agent error: ${errorMsg}`);
                return {
                    type: 'result',
                    result: `Error: ${errorMsg}`,
                };
            }
        };

        // Handle the prompt — either a string or async iterable
        if (typeof input.prompt === 'string') {
            const result = await processPrompt(input.prompt);
            if (result) yield result;
        } else {
            // Async iterable: process each user turn as it arrives
            for await (const turn of input.prompt as AsyncIterable<UserTurn>) {
                const text = turn.message.content;
                if (!text) continue;

                const result = await processPrompt(text);
                if (result) yield result;
            }
        }
    }
}
