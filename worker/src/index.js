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

// Counts one use against a daily limit; returns false once the limit is reached.
async function spend(kv, key, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const k = `${day}:${key}`;
  const used = parseInt((await kv.get(k)) || "0", 10);
  if (used >= limit) return false;
  await kv.put(k, String(used + 1), { expirationTtl: 60 * 60 * 48 });
  return true;
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
    const transcript = String(input.transcript || "").slice(0, 600);
    const voice = input.voice && typeof input.voice === "object" ? input.voice : null;
    if (!transcript && !voice) return json({ error: "Nothing to judge" }, 400, h);

    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const okIp = await spend(env.LIMITS, "ip:" + ip, parseInt(env.PER_PERSON_DAILY || "30", 10));
    if (!okIp) return json({ error: "limit", scope: "person" }, 429, h);
    const okAll = await spend(env.LIMITS, "all", parseInt(env.TOTAL_DAILY || "200", 10));
    if (!okAll) return json({ error: "limit", scope: "total" }, 429, h);

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const msg = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        system: SYSTEM,
        messages: [{
          role: "user",
          content: JSON.stringify({ transcript: transcript || "(speech recognition heard nothing clear)", voice: voice || "no voiced speech measured" })
        }]
      });
      if (msg.stop_reason === "refusal") return json({ error: "refused" }, 502, h);
      const block = msg.content.find(b => b.type === "text");
      const out = JSON.parse(block.text);
      out.confidence = Math.max(51, Math.min(99, Math.round(out.confidence)));
      return json(out, 200, h);
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) return json({ error: "busy" }, 503, h);
      if (e instanceof Anthropic.AuthenticationError) return json({ error: "server key rejected" }, 500, h);
      if (e instanceof Anthropic.APIError) return json({ error: "ai error " + e.status }, 502, h);
      return json({ error: "failed" }, 500, h);
    }
  }
};
