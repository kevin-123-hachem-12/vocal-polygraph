import Anthropic from "@anthropic-ai/sdk";

// Sites allowed to call this helper.
const ORIGINS = ["https://kevin-123-hachem-12.github.io", "http://localhost:8080", "http://127.0.0.1:8080"];

const SYSTEM = `You are the judging engine inside "Veritas VP-9", a novelty voice lie-detector game. A player said one statement about themselves into the microphone. You receive the speech-to-text transcript and acoustic measurements of their voice.
Decide LIE or TRUTH like a sharp, theatrical polygraph examiner. Weigh verbal deception cues (over-insisting, hedging, distancing language, filler words, oddly specific or vague detail, implausibility, statements that sound like a dare) together with vocal stress (tremor above ~0.35 semitones, pitch range above ~3 semitones, pause share above ~0.3, slow start above ~1 s). Typical calm speech: tremor 0.15-0.3, range 1.5-2.5, pauses 0.1-0.25.
Be decisive and varied: never sit on the fence, and do not default to TRUTH. Confidence is 55-98.
Reason: one punchy sentence of at most 14 words, addressed to the player, citing the cue you used. No hedging about the science.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "reason"],
  properties: {
    verdict: { type: "string", enum: ["LIE", "TRUTH"] },
    confidence: { type: "integer" },
    reason: { type: "string" }
  }
};

const CODE_RE = /^VP9-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin"
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json" } });

const today = () => new Date().toISOString().slice(0, 10);
const freeKey = ip => `free:${today()}:${ip}`;
const codeKey = code => `code:${code}`;

async function balance(env, ip, code) {
  const freeLimit = parseInt(env.FREE_DAILY || "3", 10);
  const usedFree = parseInt((await env.LIMITS.get(freeKey(ip))) || "0", 10);
  let credits = null;
  if (code) {
    const v = await env.LIMITS.get(codeKey(code));
    credits = v === null ? null : parseInt(v, 10);
  }
  return { freeLeft: Math.max(0, freeLimit - usedFree), usedFree, credits };
}

async function judge(env, transcript, voice) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 2000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: "user",
      content: JSON.stringify({ transcript: transcript || "(speech recognition heard nothing clear)", voice: voice || "no voiced speech measured" })
    }]
  });
  if (msg.stop_reason === "refusal") return null;
  const block = msg.content.find(b => b.type === "text");
  if (!block) return null;
  const out = JSON.parse(block.text);
  out.confidence = Math.max(51, Math.min(99, Math.round(out.confidence)));
  return out;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const h = cors(origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (req.method !== "POST") return json({ error: "Use POST" }, 405, h);
    if (!ORIGINS.includes(origin)) return json({ error: "Not allowed" }, 403, h);

    let input;
    try { input = await req.json(); } catch { return json({ error: "Bad JSON" }, 400, h); }
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const code = typeof input.code === "string" ? input.code.trim().toUpperCase() : "";
    if (code && !CODE_RE.test(code)) return json({ error: "bad_code" }, 400, h);

    const path = new URL(req.url).pathname;
    const bal = await balance(env, ip, code);
    if (code && bal.credits === null) return json({ error: "bad_code" }, 404, h);

    // How many Claude verdicts this visitor has left.
    if (path === "/status") return json({ freeLeft: bal.freeLeft, credits: bal.credits }, 200, h);

    const transcript = String(input.transcript || "").slice(0, 600);
    const voice = input.voice && typeof input.voice === "object" ? input.voice : null;
    if (!transcript && !voice) return json({ error: "Nothing to judge" }, 400, h);

    // Paid credits are used first, then the free daily allowance.
    const usePaid = code && bal.credits > 0;
    if (!usePaid && bal.freeLeft <= 0) return json({ error: "limit", freeLeft: 0, credits: bal.credits }, 429, h);

    let out;
    try { out = await judge(env, transcript, voice); }
    catch (e) {
      if (e instanceof Anthropic.RateLimitError) return json({ error: "busy" }, 503, h);
      if (e instanceof Anthropic.AuthenticationError) return json({ error: "server key rejected" }, 500, h);
      if (e instanceof Anthropic.APIError) return json({ error: "ai error " + e.status }, 502, h);
      return json({ error: "failed" }, 500, h);
    }
    if (!out) return json({ error: "no verdict" }, 502, h);

    // Charge only for a verdict that came back.
    if (usePaid) {
      await env.LIMITS.put(codeKey(code), String(bal.credits - 1));
      out.credits = bal.credits - 1; out.freeLeft = bal.freeLeft;
    } else {
      await env.LIMITS.put(freeKey(ip), String(bal.usedFree + 1), { expirationTtl: 60 * 60 * 48 });
      out.freeLeft = bal.freeLeft - 1; out.credits = bal.credits;
    }
    return json(out, 200, h);
  }
};
