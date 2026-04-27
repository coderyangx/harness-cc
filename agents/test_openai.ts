import OpenAI from 'openai';
import 'dotenv/config';

const client = new OpenAI({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    'User-Agent': 'node-fetch',
  },
});

const res = await client.chat.completions.create({
  model: 'gpt-5.4-mini',
  messages: [{ role: 'user', content: '你是谁' }],
  // stream: false,
});
console.log('Test 响应:', res.model, res.usage, res.choices);
// console.log('Test 成功:', JSON.stringify(res.choices?.[0]?.message?.content, null, 4));

// console.log('Test 成功:', res.choices?.[0]?.message?.content);
