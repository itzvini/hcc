'use strict';

// AI-assisted derivation of a candidate's stance per VAA proposition from their
// open answers. Uses OpenAI Chat Completions with a strict json_schema response
// format, so the output is always the exact shape we expect. The candidate REVIEWS
// and confirms every suggestion before anything is saved — this only removes the
// blank page. Called via fetch (no SDK dependency).

const fs = require('node:fs');
const path = require('node:path');
const { PROPOSITIONS } = require('./propositions');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
// Recent, reliable, cheap. GPT-5 family are reasoning models, so we use
// max_completion_tokens + a low reasoning_effort (this task needs little reasoning).
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const IS_REASONING = /^(gpt-5|o\d)/.test(MODEL);

function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

// English statements from locales/en.json (single source of truth), cached.
let _statements = null;
function statements() {
  if (_statements) return _statements;
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'en.json'), 'utf8'));
  _statements = PROPOSITIONS.map(p => ({ id: p.id, statement: en[`prop.${p.id}`] || p.id }));
  return _statements;
}

// Strict json_schema: every object needs additionalProperties:false and all keys required.
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    positions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', enum: PROPOSITIONS.map(p => p.id) },
          stance: { type: 'integer', enum: [1, 2, 3, 4, 5] },
          rationale: { type: 'string' },
        },
        required: ['id', 'stance', 'rationale'],
      },
    },
  },
  required: ['positions'],
};

const SYSTEM = `You map a Council candidate's free-text answers onto a fixed list of position statements for a Voting Advice Application.

For EACH statement, output:
- "stance": 1-5 where 1 = strongly disagree, 2 = disagree, 3 = neutral or unclear, 4 = agree, 5 = strongly agree.
- "rationale": one sentence (<= 200 characters), grounded in the candidate's own words, explaining the stance.

Rules:
- Be faithful and neutral. Infer only what the answers support; never invent a position.
- If the answers don't clearly address a statement, use stance 3 and say so in the rationale.
- Return exactly one entry per statement, using the ids exactly as given.`;

async function derivePositions(answers) {
  if (!isConfigured()) throw new Error('AI position drafting is not configured.');

  const propList = statements().map((p, i) => `${i + 1}. [${p.id}] ${p.statement}`).join('\n');
  const answerList = Object.entries(answers || {})
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `Q(${k}): ${String(v).trim()}`)
    .join('\n\n') || '(the candidate left their answers blank)';

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `STATEMENTS:\n${propList}\n\nCANDIDATE ANSWERS:\n${answerList}` },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'vaa_positions', strict: true, schema: OUTPUT_SCHEMA },
      },
      // Reasoning models consume this budget on thinking too, so leave headroom.
      max_completion_tokens: 4000,
      ...(IS_REASONING ? { reasoning_effort: 'low' } : {}),
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* ignore */ }
    throw new Error(`OpenAI API ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('The model returned an unparseable response.'); }

  // Sanitize and guarantee one entry per proposition (default to neutral if missing).
  const byId = {};
  for (const p of (parsed.positions || [])) {
    if (!PROPOSITIONS.find(x => x.id === p.id)) continue;
    const stance = Math.min(5, Math.max(1, parseInt(p.stance, 10) || 3));
    byId[p.id] = { stance, rationale: String(p.rationale || '').slice(0, 200) };
  }
  return PROPOSITIONS.map(p => ({
    id: p.id,
    stance: byId[p.id]?.stance ?? 3,
    rationale: byId[p.id]?.rationale ?? '',
  }));
}

module.exports = { derivePositions, isConfigured };
