import { Tiktoken } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';

type TokenEstimationInput = {
  text: string;
  modelName: string;
};

type TokenEstimationResult = {
  tokens: number;
  method: 'tiktoken-cl100k' | 'char-fallback';
  confidence: 'high' | 'medium' | 'low';
};

type ImageTokenEstimation = {
  tokens: number;
  detail: 'low' | 'high' | 'auto';
};

// 全局 tokenizer 实例缓存
let cl100kTokenizer: Tiktoken | null = null;

// 不使用 cl100k_base 的模型（极少数）
const MODEL_SKIP_CL100K: string[] = [
  // 目前没有需要跳过的模型
  // 如果发现某些模型用 cl100k_base 估算偏差很大，可以添加到这里
];

function shouldUseCl100k(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  // 默认对所有模型使用 cl100k_base，除非在跳过列表中
  return !MODEL_SKIP_CL100K.some((skip) => normalized.includes(skip));
}

function getCl100kTokenizer(): Tiktoken {
  if (!cl100kTokenizer) {
    cl100kTokenizer = new Tiktoken(cl100k_base);
  }
  return cl100kTokenizer;
}

// 字符数估算（最后的 fallback）
function estimateTokensByChars(text: string): number {
  if (!text || text.length === 0) return 0;

  // 统计中文字符
  const chineseChars = (text.match(/[一-龥]/g) || []).length;
  // 统计日文字符
  const japaneseChars = (text.match(/[぀-ゟ゠-ヿ]/g) || []).length;
  // 统计韩文字符
  const koreanChars = (text.match(/[가-힯]/g) || []).length;

  const cjkChars = chineseChars + japaneseChars + koreanChars;
  const otherChars = text.length - cjkChars;

  // CJK: 约 1.5 字符 = 1 token
  // 英文: 约 4 字符 = 1 token
  return Math.ceil(cjkChars / 1.5 + otherChars / 4);
}

export function estimateTokenCount(input: TokenEstimationInput): TokenEstimationResult {
  if (!input.text || input.text.length === 0) {
    return { tokens: 0, method: 'char-fallback', confidence: 'high' };
  }

  // 尝试使用 tiktoken
  if (shouldUseCl100k(input.modelName)) {
    try {
      const tokenizer = getCl100kTokenizer();
      const tokens = tokenizer.encode(input.text).length;
      return { tokens, method: 'tiktoken-cl100k', confidence: 'high' };
    } catch (error) {
      console.warn('[token-estimation] tiktoken failed, falling back to char estimation', error);
    }
  }

  // Fallback 到字符估算
  const tokens = estimateTokensByChars(input.text);
  const confidence = shouldUseCl100k(input.modelName) ? 'medium' : 'low';
  return { tokens, method: 'char-fallback', confidence };
}

// 从 OpenAI/Anthropic 格式的 messages 中提取文本
function extractTextFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return '';

  let text = '';
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    const message = msg as Record<string, unknown>;
    const content = message.content;

    // 字符串内容
    if (typeof content === 'string') {
      text += content + '\n';
      continue;
    }

    // 数组内容（多模态）
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const partObj = part as Record<string, unknown>;

        // 文本部分
        if (partObj.type === 'text' && typeof partObj.text === 'string') {
          text += partObj.text + '\n';
        }

        // 图片部分（添加占位符，实际 token 数需要单独计算）
        if (partObj.type === 'image' || partObj.type === 'image_url') {
          text += '[IMAGE]\n';
        }
      }
    }
  }

  return text.trim();
}

// 从 SSE 流式响应中提取文本内容
export function extractTextFromSseStream(sseText: string): string {
  if (!sseText || typeof sseText !== 'string') {
    return '';
  }

  let accumulatedText = '';
  const lines = sseText.split('\n');

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;

    const dataContent = line.slice(6).trim();
    if (!dataContent || dataContent === '[DONE]') continue;

    try {
      const parsed = JSON.parse(dataContent);

      // OpenAI 格式
      if (Array.isArray(parsed.choices)) {
        for (const choice of parsed.choices) {
          if (choice && typeof choice === 'object') {
            const delta = choice.delta;
            if (delta && typeof delta === 'object') {
              if (typeof delta.content === 'string') {
                accumulatedText += delta.content;
              }
            }
          }
        }
      }

      // Anthropic 格式
      if (parsed.type === 'content_block_delta' && parsed.delta) {
        if (typeof parsed.delta.text === 'string') {
          accumulatedText += parsed.delta.text;
        }
      }
    } catch (parseError) {
      // 忽略解析失败的块
    }
  }

  return accumulatedText;
}

// 从请求 body 中提取文本内容
export function extractRequestText(body: unknown, modelName: string): string {
  if (!body || typeof body !== 'object') return '';

  const record = body as Record<string, unknown>;
  let text = '';

  // System prompt
  if (typeof record.system === 'string') {
    text += record.system + '\n\n';
  }

  // Messages
  if (Array.isArray(record.messages)) {
    text += extractTextFromMessages(record.messages);
  }

  // Prompt (某些旧格式)
  if (typeof record.prompt === 'string' && !text) {
    text = record.prompt;
  }

  // 工具定义（也会消耗 token）
  if (Array.isArray(record.tools)) {
    try {
      text += '\n[TOOLS: ' + JSON.stringify(record.tools) + ']';
    } catch {
      // ignore
    }
  }

  if (Array.isArray(record.functions)) {
    try {
      text += '\n[FUNCTIONS: ' + JSON.stringify(record.functions) + ']';
    } catch {
      // ignore
    }
  }

  return text.trim();
}

// 从响应 body 中提取文本内容
export function extractResponseText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';

  const record = body as Record<string, unknown>;
  let text = '';

  // OpenAI 格式
  if (Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      if (!choice || typeof choice !== 'object') continue;
      const choiceObj = choice as Record<string, unknown>;

      // message.content
      const message = choiceObj.message;
      if (message && typeof message === 'object') {
        const msgObj = message as Record<string, unknown>;
        if (typeof msgObj.content === 'string') {
          text += msgObj.content + '\n';
        }

        // 工具调用
        if (Array.isArray(msgObj.tool_calls)) {
          try {
            text += '[TOOL_CALLS: ' + JSON.stringify(msgObj.tool_calls) + ']\n';
          } catch {
            // ignore
          }
        }

        if (msgObj.function_call && typeof msgObj.function_call === 'object') {
          try {
            text += '[FUNCTION_CALL: ' + JSON.stringify(msgObj.function_call) + ']\n';
          } catch {
            // ignore
          }
        }
      }

      // delta.content (流式)
      const delta = choiceObj.delta;
      if (delta && typeof delta === 'object') {
        const deltaObj = delta as Record<string, unknown>;
        if (typeof deltaObj.content === 'string') {
          text += deltaObj.content;
        }
      }
    }
  }

  // Anthropic 格式
  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (!block || typeof block !== 'object') continue;
      const blockObj = block as Record<string, unknown>;

      if (blockObj.type === 'text' && typeof blockObj.text === 'string') {
        text += blockObj.text + '\n';
      }

      if (blockObj.type === 'tool_use') {
        try {
          text += '[TOOL_USE: ' + JSON.stringify(blockObj) + ']\n';
        } catch {
          // ignore
        }
      }
    }
  }

  // Gemini 格式
  if (Array.isArray(record.candidates)) {
    for (const candidate of record.candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const candidateObj = candidate as Record<string, unknown>;

      const content = candidateObj.content;
      if (content && typeof content === 'object') {
        const contentObj = content as Record<string, unknown>;
        if (Array.isArray(contentObj.parts)) {
          for (const part of contentObj.parts) {
            if (part && typeof part === 'object') {
              const partObj = part as Record<string, unknown>;
              if (typeof partObj.text === 'string') {
                text += partObj.text + '\n';
              }
            }
          }
        }
      }
    }
  }

  return text.trim();
}

// 估算图片的 token 数（基于 OpenAI 的计算方式）
export function estimateImageTokens(input: {
  width?: number;
  height?: number;
  detail?: 'low' | 'high' | 'auto';
}): ImageTokenEstimation {
  const detail = input.detail || 'auto';

  // 低分辨率固定 85 tokens
  if (detail === 'low') {
    return { tokens: 85, detail: 'low' };
  }

  // 高分辨率根据尺寸计算
  if (input.width && input.height) {
    const tiles = Math.ceil(input.width / 512) * Math.ceil(input.height / 512);
    const tokens = tiles * 170 + 85;
    return { tokens, detail: 'high' };
  }

  // 默认假设高分辨率中等尺寸
  return { tokens: 255, detail: 'auto' };
}

// 从请求中统计图片数量并估算 token
export function estimateRequestImageTokens(body: unknown): number {
  if (!body || typeof body !== 'object') return 0;

  const record = body as Record<string, unknown>;
  let totalTokens = 0;

  if (Array.isArray(record.messages)) {
    for (const msg of record.messages) {
      if (!msg || typeof msg !== 'object') continue;
      const message = msg as Record<string, unknown>;
      const content = message.content;

      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== 'object') continue;
          const partObj = part as Record<string, unknown>;

          if (partObj.type === 'image' || partObj.type === 'image_url') {
            const imageUrl = partObj.image_url;
            let detail: 'low' | 'high' | 'auto' = 'auto';

            if (imageUrl && typeof imageUrl === 'object') {
              const imageUrlObj = imageUrl as Record<string, unknown>;
              if (imageUrlObj.detail === 'low' || imageUrlObj.detail === 'high') {
                detail = imageUrlObj.detail;
              }
            }

            const estimation = estimateImageTokens({ detail });
            totalTokens += estimation.tokens;
          }
        }
      }
    }
  }

  return totalTokens;
}

// 清理资源
export function cleanupTokenizers(): void {
  if (cl100kTokenizer) {
    // js-tiktoken 不需要手动释放资源
    cl100kTokenizer = null;
  }
}

// 进程退出时清理
if (typeof process !== 'undefined') {
  process.on('beforeExit', cleanupTokenizers);
}
