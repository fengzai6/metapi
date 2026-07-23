import { anthropicMessagesTransformer } from '../../anthropic/messages/index.js';
import {
  applyAnthropicMessagesAggregateEvent,
  createAnthropicMessagesAggregateState,
} from '../../anthropic/messages/aggregator.js';
import { createProxyStreamLifecycle } from '../../shared/protocolLifecycle.js';
import { type DownstreamFormat, type ParsedSseEvent } from '../../shared/normalized.js';
import { createOpenAiChatAggregateState, applyOpenAiChatStreamEvent, finalizeOpenAiChatAggregate } from './aggregator.js';
import {
  buildNormalizedFinalToOpenAiChatChunks,
  normalizeOpenAiChatFinalToNormalized,
} from './responseBridge.js';
import { openAiChatStream } from './streamBridge.js';
import { config } from '../../../config.js';

type StreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

type ChatProxyStreamSessionInput = {
  downstreamFormat: DownstreamFormat;
  modelName: string;
  successfulUpstreamPath: string;
  onParsedPayload?: (payload: unknown) => void;
  writeLines: (lines: string[]) => void;
  writeRaw: (chunk: string) => void;
};

type ResponseSink = {
  end(): void;
};

type ChatProxyStreamResult = {
  status: 'completed' | 'failed';
  errorMessage: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function hasMeaningfulAnthropicPayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const type = typeof payload.type === 'string' ? payload.type : '';

  if (type === 'content_block_delta' && isRecord(payload.delta)) {
    const delta = payload.delta;
    const deltaType = typeof delta.type === 'string' ? delta.type : '';
    if (deltaType === 'text_delta' && hasNonEmptyString(delta.text)) return true;
    if (deltaType === 'thinking_delta' && (hasNonEmptyString(delta.thinking) || hasNonEmptyString(delta.text))) return true;
    if (deltaType === 'input_json_delta' && hasNonEmptyString(delta.partial_json)) return true;
    if (deltaType === 'signature_delta' && hasNonEmptyString(delta.signature)) return true;
  }

  if (type === 'content_block_start' && isRecord(payload.content_block)) {
    const block = payload.content_block;
    const blockType = typeof block.type === 'string' ? block.type : '';
    if (blockType === 'tool_use' || blockType === 'server_tool_use') return true;
    if (blockType === 'text' && hasNonEmptyString(block.text)) return true;
    if (blockType === 'thinking' && hasNonEmptyString(block.thinking)) return true;
    if (blockType === 'redacted_thinking' && hasNonEmptyString(block.data)) return true;
  }

  if (Array.isArray(payload.content)) {
    for (const part of payload.content) {
      if (!isRecord(part)) continue;
      const partType = typeof part.type === 'string' ? part.type : '';
      if (partType === 'tool_use' || partType === 'server_tool_use') return true;
      if (hasNonEmptyString(part.text) || hasNonEmptyString(part.thinking) || hasNonEmptyString(part.data)) return true;
    }
  }

  return false;
}

export function createChatProxyStreamSession(input: ChatProxyStreamSessionInput) {
  const downstreamTransformer = input.downstreamFormat === 'claude'
    ? anthropicMessagesTransformer
    : {
      createStreamContext: openAiChatStream.createContext,
      transformStreamEvent: openAiChatStream.normalizeEvent,
      serializeStreamEvent: openAiChatStream.serializeEvent,
      serializeDone: openAiChatStream.serializeDone,
      pullSseEvents: openAiChatStream.pullSseEvents,
    };
  const streamContext = downstreamTransformer.createStreamContext(input.modelName);
  const claudeContext = anthropicMessagesTransformer.createDownstreamContext();
  const chatAggregateState = input.downstreamFormat === 'openai'
    ? createOpenAiChatAggregateState()
    : null;
  const anthropicAggregateState = input.downstreamFormat === 'claude'
    ? createAnthropicMessagesAggregateState()
    : null;
  let finalized = false;
  let terminalResult: ChatProxyStreamResult = {
    status: 'completed',
    errorMessage: null,
  };
  let terminalNormalizedFinal: ReturnType<typeof normalizeOpenAiChatFinalToNormalized> | null = null;
  let forwardedDownstreamOutput = false;
  const pendingWrites: string[] = [];

  const extractFailureMessage = (payload: unknown, fallback = 'upstream stream failed'): string => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
        const message = (record.error as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim()) return message.trim();
      }
      if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
      if (record.response && typeof record.response === 'object' && !Array.isArray(record.response)) {
        const responseError = (record.response as Record<string, unknown>).error;
        if (responseError && typeof responseError === 'object' && !Array.isArray(responseError)) {
          const message = (responseError as Record<string, unknown>).message;
          if (typeof message === 'string' && message.trim()) return message.trim();
        }
      }
    }
    return fallback;
  };

  const markFailed = (payload: unknown, fallbackMessage?: string) => {
    terminalResult = {
      status: 'failed',
      errorMessage: extractFailureMessage(payload, fallbackMessage),
    };
  };

  const hasMeaningfulChatAggregateOutput = (): boolean => {
    if (input.downstreamFormat !== 'openai' || !chatAggregateState) return false;
    for (const choice of chatAggregateState.choices.values()) {
      if (choice.content.length > 0) return true;
      if (choice.reasoning.length > 0) return true;
      if (choice.toolCalls.some((item) => item.id || item.name || item.arguments)) return true;
    }
    return false;
  };

  const hasMeaningfulAnthropicAggregateOutput = (): boolean => {
    if (input.downstreamFormat !== 'claude' || !anthropicAggregateState) return false;
    if (anthropicAggregateState.text.some((part) => part.length > 0)) return true;
    if (anthropicAggregateState.reasoning.some((part) => part.length > 0)) return true;
    if (anthropicAggregateState.redactedReasoning.some((part) => part.length > 0)) return true;
    return Object.values(anthropicAggregateState.toolCalls).some((tool) => (
      !!tool.id || !!tool.name || tool.arguments.length > 0
    ));
  };

  const hasMeaningfulNormalizedFinalOutput = (): boolean => {
    if (!terminalNormalizedFinal) return false;
    const choices = Array.isArray(terminalNormalizedFinal.choices)
      ? terminalNormalizedFinal.choices
      : [];
    if (choices.some((choice) => (
      choice.content.length > 0
      || choice.reasoningContent.length > 0
      || choice.toolCalls.some((toolCall) => toolCall.id || toolCall.name || toolCall.arguments)
    ))) {
      return true;
    }
    if (terminalNormalizedFinal.content.length > 0) return true;
    if (terminalNormalizedFinal.reasoningContent.length > 0) return true;
    return terminalNormalizedFinal.toolCalls.some((toolCall) => toolCall.id || toolCall.name || toolCall.arguments);
  };

  const hasMeaningfulOutput = (): boolean => (
    hasMeaningfulChatAggregateOutput()
    || hasMeaningfulAnthropicAggregateOutput()
    || hasMeaningfulNormalizedFinalOutput()
  );

  const flushPendingWrites = () => {
    if (pendingWrites.length <= 0) return;
    input.writeLines([...pendingWrites]);
    pendingWrites.length = 0;
  };

  const emitLines = (lines: string[], options?: { meaningful?: boolean; force?: boolean }) => {
    if (lines.length <= 0) return;
    if (forwardedDownstreamOutput) {
      input.writeLines(lines);
      return;
    }
    if (options?.force) {
      pendingWrites.length = 0;
      forwardedDownstreamOutput = true;
      input.writeLines(lines);
      return;
    }
    if (options?.meaningful) {
      forwardedDownstreamOutput = true;
      flushPendingWrites();
      input.writeLines(lines);
      return;
    }
    // Buffer until we know the stream has meaningful content, so empty
    // completions can still return HTTP 502 and be retried before hijack.
    pendingWrites.push(...lines);
  };

  const emitRaw = (chunk: string, options?: { meaningful?: boolean; force?: boolean }) => {
    if (!chunk) return;
    if (forwardedDownstreamOutput) {
      input.writeRaw(chunk);
      return;
    }
    if (options?.force) {
      pendingWrites.length = 0;
      forwardedDownstreamOutput = true;
      input.writeRaw(chunk);
      return;
    }
    if (options?.meaningful) {
      forwardedDownstreamOutput = true;
      flushPendingWrites();
      input.writeRaw(chunk);
      return;
    }
    pendingWrites.push(chunk);
  };

  const shouldFailEmptyChatCompletion = (): boolean => {
    if (!config.proxyEmptyContentFailEnabled) return false;
    if (terminalResult.status === 'failed') return false;
    if (hasMeaningfulOutput()) return false;
    return true;
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;

    if (shouldFailEmptyChatCompletion()) {
      pendingWrites.length = 0;
      markFailed({
        error: {
          message: 'Upstream returned empty content',
        },
      }, 'Upstream returned empty content');
      return;
    }

    if (!forwardedDownstreamOutput) {
      forwardedDownstreamOutput = true;
      flushPendingWrites();
    }

    // For native Anthropic streams, EOF without message_stop is not a clean
    // completion. Forward the partial stream as-is instead of fabricating an
    // end_turn/message_stop pair that makes clients think the run finished.
    if (input.downstreamFormat === 'claude' && !claudeContext.doneSent) {
      return;
    }

    if (
      input.downstreamFormat === 'openai'
      && terminalResult.status !== 'failed'
      && chatAggregateState
      && chatAggregateState.choices.size > 0
    ) {
      const needsTerminalFinishChunk = Array.from(chatAggregateState.choices.values())
        .some((choice) => !choice.finishReason);
      if (needsTerminalFinishChunk) {
        const terminalChunk = buildNormalizedFinalToOpenAiChatChunks(
          finalizeOpenAiChatAggregate(chatAggregateState, {
            id: streamContext.id,
            model: streamContext.model,
            created: streamContext.created,
            content: '',
            reasoningContent: '',
            finishReason: 'stop',
            toolCalls: [],
          }),
        ).slice(-1)[0];
        if (terminalChunk) {
          emitLines([`data: ${JSON.stringify(terminalChunk)}\n\n`], { meaningful: true });
        }
      }
    }

    emitLines(downstreamTransformer.serializeDone(streamContext, claudeContext), { meaningful: true });
  };

  const handleEventBlock = async (eventBlock: ParsedSseEvent): Promise<boolean> => {
    if (eventBlock.data === '[DONE]') {
      finalize();
      return true;
    }

    let parsedPayload: unknown = null;
    if (input.downstreamFormat === 'claude') {
      const consumed = anthropicMessagesTransformer.consumeSseEventBlock(
        eventBlock,
        streamContext,
        claudeContext,
        input.modelName,
      );
      parsedPayload = consumed.parsedPayload;
      if (parsedPayload && typeof parsedPayload === 'object') {
        input.onParsedPayload?.(parsedPayload);
        if (anthropicAggregateState) {
          applyAnthropicMessagesAggregateEvent(
            anthropicAggregateState,
            anthropicMessagesTransformer.transformStreamEvent(parsedPayload, streamContext, input.modelName),
          );
        }
      }
      if (consumed.handled) {
        const meaningful = hasMeaningfulAnthropicPayload(parsedPayload) || hasMeaningfulAnthropicAggregateOutput();
        emitLines(consumed.lines, { meaningful });
        if (consumed.done) {
          finalize();
          return true;
        }
        return false;
      }
    } else {
      try {
        parsedPayload = JSON.parse(eventBlock.data);
      } catch {
        parsedPayload = null;
      }
      if (parsedPayload && typeof parsedPayload === 'object') {
        input.onParsedPayload?.(parsedPayload);
      }
    }

    if (parsedPayload && typeof parsedPayload === 'object') {
      const payloadType = typeof (parsedPayload as Record<string, unknown>).type === 'string'
        ? String((parsedPayload as Record<string, unknown>).type)
        : '';
      const isFailurePayload = payloadType === 'response.failed' || payloadType === 'error';
      if (isFailurePayload) {
        markFailed(parsedPayload);
      }
      const normalizedEvent = downstreamTransformer.transformStreamEvent(parsedPayload, streamContext, input.modelName);
      if (input.downstreamFormat === 'openai' && chatAggregateState) {
        applyOpenAiChatStreamEvent(chatAggregateState, normalizedEvent);
      }
      if (input.downstreamFormat === 'claude' && anthropicAggregateState) {
        applyAnthropicMessagesAggregateEvent(anthropicAggregateState, normalizedEvent);
      }
      emitLines(
        downstreamTransformer.serializeStreamEvent(normalizedEvent, streamContext, claudeContext),
        {
          meaningful: hasMeaningfulOutput(),
          force: isFailurePayload,
        },
      );
      if (input.downstreamFormat === 'claude' && claudeContext.doneSent) {
        finalize();
        return true;
      }
      return false;
    }

    if (input.downstreamFormat === 'openai') {
      emitRaw(`data: ${eventBlock.data}\n\n`, { meaningful: true });
      return false;
    }

    emitLines(anthropicMessagesTransformer.serializeStreamEvent({
      contentDelta: eventBlock.data,
    }, streamContext, claudeContext), { meaningful: true });
    if (claudeContext.doneSent) {
      finalize();
      return true;
    }
    return false;
  };

  return {
    consumeUpstreamFinalPayload(payload: unknown, fallbackText: string, response?: ResponseSink): ChatProxyStreamResult {
      if (payload && typeof payload === 'object') {
        input.onParsedPayload?.(payload);
      }
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const payloadType = typeof (payload as Record<string, unknown>).type === 'string'
          ? String((payload as Record<string, unknown>).type)
          : '';
        if (payloadType === 'response.failed' || payloadType === 'error') {
          markFailed(payload);
        }
      }
      if (input.downstreamFormat === 'openai') {
        const normalizedFinal = normalizeOpenAiChatFinalToNormalized(payload, input.modelName, fallbackText);
        terminalNormalizedFinal = normalizedFinal;
        streamContext.id = normalizedFinal.id;
        streamContext.model = normalizedFinal.model;
        streamContext.created = normalizedFinal.created;
        emitLines(
          buildNormalizedFinalToOpenAiChatChunks(normalizedFinal)
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
          { meaningful: true },
        );
      } else {
        if (anthropicAggregateState && hasMeaningfulAnthropicPayload(payload)) {
          // Final payload with content counts as meaningful even before streaming.
          applyAnthropicMessagesAggregateEvent(
            anthropicAggregateState,
            anthropicMessagesTransformer.transformStreamEvent(payload, streamContext, input.modelName),
          );
        }
        emitLines(
          anthropicMessagesTransformer.serializeUpstreamFinalAsStream(
            payload,
            input.modelName,
            fallbackText,
            streamContext,
            claudeContext,
          ),
          { meaningful: hasMeaningfulAnthropicPayload(payload) || hasMeaningfulAnthropicAggregateOutput() },
        );
      }
      finalize();
      response?.end();
      return terminalResult;
    },
    async run(reader: StreamReader | null | undefined, response: ResponseSink): Promise<ChatProxyStreamResult> {
      const lifecycle = createProxyStreamLifecycle<ParsedSseEvent>({
        reader,
        response,
        pullEvents: (buffer) => downstreamTransformer.pullSseEvents(buffer),
        handleEvent: handleEventBlock,
        onEof: finalize,
      });
      await lifecycle.run();
      return terminalResult;
    },
  };
}
