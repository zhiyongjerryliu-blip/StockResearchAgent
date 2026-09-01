import { config } from './config.js';

export function llmConfigured() {
  return Boolean(config.llm.enabled && config.llm.apiKey && config.llm.model);
}

export async function explainStructuredReview(structuredReview, fetchImpl = fetch) {
  if (!llmConfigured()) return null;
  const response = await fetchImpl(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.apiKey}`
    },
    body: JSON.stringify({
      model: config.llm.model,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: [
            '你是美股投研复盘编辑。只能使用用户提供的结构化事实，不得补充或猜测任何新闻、价格、机构身份或目标价。',
            '明确区分事实、模型推断和数据缺失。使用简洁中文，先总结当日表现，再说明持仓收益、风险和次日观察。',
            '当priceDataStatus不是COMPLETE，或previousClose、dailyReturn、dailyPnl任一缺失时，必须明确说明前一交易日行情不完整，禁止推断涨跌幅和当日盈亏。',
            '如果数据不足，直接写数据不足。不得给出确定买卖命令。'
          ].join('')
        },
        { role: 'user', content: JSON.stringify(structuredReview) }
      ]
    }),
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) throw new Error(`LLM请求失败：HTTP ${response.status}`);
  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content?.trim() || null;
}
