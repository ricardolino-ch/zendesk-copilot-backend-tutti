require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function getLanguageName(code) {
  const map = {
    de: "German",
    fr: "French",
    it: "Italian",
    en: "English"
  };
  return map[code] || "German";
}

function getGreeting() {
  return "Guten Tag";
}

function getClosing() {
  return "Beste Grüsse";
}

async function runPrompt(prompt) {
  const response = await client.responses.create({
    model: "gpt-5.4",
    input: prompt
  });

  return response.output_text || "";
}

function getZendeskAuthHeader() {
  const email = process.env.ZENDESK_EMAIL;
  const token = process.env.ZENDESK_API_TOKEN;

  const raw = `${email}/token:${token}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

function getZendeskBaseUrl() {
  return `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
}

async function zendeskGet(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": getZendeskAuthHeader(),
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error("Zendesk API Fehler");
  }

  return response.json();
}

function shortenText(text, maxLength = 1200) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + " ...";
}

async function buildTicketContext(ticketId) {
  const baseUrl = getZendeskBaseUrl();

  const [ticketJson, commentsJson] = await Promise.all([
    zendeskGet(`${baseUrl}/tickets/${ticketId}.json`),
    zendeskGet(`${baseUrl}/tickets/${ticketId}/comments.json?sort=-created_at`)
  ]);

  const ticket = ticketJson.ticket || {};
  const comments = (commentsJson.comments || []).slice(0, 3);

  const commentText = comments
    .reverse()
    .map(c => c.plain_body || "")
    .join("\n\n");

  return `
Betreff:
${ticket.subject || ""}

Beschreibung:
${ticket.description || ""}

Kommentare:
${commentText}
`;
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/copilot", async (req, res) => {
  try {
    const {
      action,
      targetLanguage = "de",
      text = "",
      ticketId = ""
    } = req.body;

    const languageName = getLanguageName(targetLanguage);

    let prompt = "";

    if (action === "summarize_ticket") {

      const context = await buildTicketContext(ticketId);

      prompt = `
You are a Zendesk support assistant.

Create a SHORT and PRECISE summary in ${languageName}.

Rules:
- ONLY bullet points
- max 4 bullet points
- each bullet max 1 sentence
- no intro text
- no conclusion
- focus only on important facts

Focus on:
- problem
- key data
- what the customer wants

Use wording:
Profil
Account

Ticket:
${context}
`;
    }

    else if (action === "translate_summary") {
      prompt = `
Translate the following text into ${languageName}.
Keep bullet structure.
Do not expand.

Text:
${text}
`;
    }

    else if (action === "reply_from_summary") {
      prompt = `
You are a tutti.ch support agent.

Write a clean customer reply in German.

Rules:
- friendly
- short
- clear
- no internal wording

Use wording:
Profil
Account

Use exactly this greeting:
${getGreeting()}

Use exactly this closing:
${getClosing()}

Summary:
${text}
`;
    }

    else if (action === "improve_text") {
      prompt = `
You are a tutti.ch support copilot.

Turn the following draft into a professional customer reply.

Rules:
- detect language automatically
- keep same language
- improve wording
- keep message concise
- ALWAYS use exactly this greeting:
${getGreeting()}
- ALWAYS use exactly this closing:
${getClosing()}
- do not add names
- do not add extra signature
- use wording:
  Profil
  Account

Return ONLY the final reply.

Original text:
${text}
`;
    }

    else if (action === "translate_text") {

      prompt = `
You are a tutti.ch support copilot.

Translate the following customer reply into ${languageName}.

IMPORTANT:
- Translate EVERYTHING
- The greeting MUST always be:
${getGreeting()}
- The closing MUST always be:
${getClosing()}
- Do NOT keep old greetings
- Do NOT keep old closings
- Replace them with the correct tutti wording
- Use wording:
  Profil
  Account

Return ONLY the final translated customer reply.

Original text:
${text}
`;
    }

    else {
      return res.status(400).json({
        error: "Invalid action"
      });
    }

    const output = await runPrompt(prompt);

    res.json({ output });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Backend error"
    });
  }
});

app.listen(port, () => {
  console.log("Server running");
});
