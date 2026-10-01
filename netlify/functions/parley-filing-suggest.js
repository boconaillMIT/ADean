// Suggests a filing folder for the open email. The client supplies the allowed
// folder list; the model may only choose from that list. No mailbox access or
// move operation is performed by this function.
const PARLEY_URL = "https://parley.api.mit.edu/v1/chat/completions";
const MODEL = "bedrock/claude-sonnet-4-6";

function reply(statusCode, body) {
  return { statusCode, headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  }, body: JSON.stringify(body) };
}
function allowedFolders(input) {
  const seen = new Map();
  (Array.isArray(input) ? input : []).forEach((value) => {
    const folder = String(value || "").trim();
    if (folder && folder.length <= 300 && !seen.has(folder.toLowerCase())) seen.set(folder.toLowerCase(), folder);
  });
  return seen;
}
function parseJson(text) {
  const cleaned = String(text || "").replace(/```json|```/gi, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("Parley did not return JSON");
  return JSON.parse(cleaned.slice(first, last + 1));
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return reply(204, {});
  if (event.httpMethod !== "POST") return reply(405, { error: "Use POST" });
  const apiKey = process.env.PARLEY_API_KEY;
  if (!apiKey) return reply(500, { error: "PARLEY_API_KEY is not set in Netlify." });

  let input;
  try { input = JSON.parse(event.body || "{}"); }
  catch { return reply(400, { error: "Invalid JSON body" }); }
  const folders = allowedFolders(input.folders);
  const body = String(input.body || "").trim();
  if (!folders.size) return reply(400, { error: "At least one filing folder is required." });
  if (!body && !String(input.subject || "").trim()) return reply(400, { error: "The email is empty." });

  const prompt = `Classify this email into the best matching filing folder. You may ONLY return folder names from the approved list. Do not invent a new folder. Prefer no suggestion when the email is too ambiguous.

Return only JSON in this exact format:
{"suggestions":[{"folder":"exact approved folder name","confidence":"high|medium|low","reason":"brief reason"}]}

Rules:
- Return at most three suggestions, in descending confidence.
- A reason must be one short sentence and must not contain sensitive details beyond what is necessary to explain the category.
- If none fit, return {"suggestions":[]}.

APPROVED FOLDERS:
${JSON.stringify(Array.from(folders.values()))}

EMAIL SUBJECT:
${String(input.subject || "").slice(0, 1000)}

EMAIL BODY:
${body.slice(0, 30000)}`;

  try {
    const response = await fetch(PARLEY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, temperature: 0, messages: [{ role: "user", content: prompt }] })
    });
    const responseText = await response.text();
    if (!response.ok) return reply(502, { error: "Parley returned an error", detail: responseText.slice(0, 500) });
    const content = JSON.parse(responseText)?.choices?.[0]?.message?.content || "";
    const parsed = parseJson(content);
    const used = new Set();
    const suggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : []).reduce((items, candidate) => {
      const folder = folders.get(String(candidate && candidate.folder || "").trim().toLowerCase());
      const confidence = String(candidate && candidate.confidence || "low").toLowerCase();
      if (!folder || used.has(folder.toLowerCase()) || !["high", "medium", "low"].includes(confidence)) return items;
      used.add(folder.toLowerCase());
      items.push({ folder, confidence, reason: String(candidate.reason || "Matches the email topic.").slice(0, 400) });
      return items;
    }, []).slice(0, 3);
    return reply(200, { suggestions });
  } catch (error) {
    return reply(500, { error: String(error.message || error) });
  }
};
