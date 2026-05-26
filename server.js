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

function getGreeting(code, requesterName) {
  const safeName = requesterName || "{{ticket.requester.name}}";

  const greetings = {
    de: `Grüezi ${safeName}

Vielen Dank für Ihre Anfrage.`,
    fr: `Bonjour ${safeName}

Merci beaucoup pour votre demande.`,
    it: `Gentile ${safeName}

La ringraziamo per la Sua richiesta.`,
    en: `Hello ${safeName}

Thank you for your inquiry.`
  };

  return greetings[code] || greetings.de;
}

function getClosing(code) {
  const closings = {
    de: "Freundliche Grüsse",
    fr: "Meilleures salutations",
    it: "Cordiali saluti",
    en: "Kind regards"
  };

  return closings[code] || closings.de;
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

  if (!email || !token) {
    throw new Error("ZENDESK_EMAIL oder ZENDESK_API_TOKEN fehlt");
  }

  const raw = `${email}/token:${token}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

function getZendeskBaseUrl() {
  const subdomain = process.env.ZENDESK_SUBDOMAIN;

  if (!subdomain) {
    throw new Error("ZENDESK_SUBDOMAIN fehlt");
  }

  return `https://${subdomain}.zendesk.com/api/v2`;
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
    const text = await response.text();
    throw new Error(`Zendesk request failed: ${response.status} ${text}`);
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
  const comments = Array.isArray(commentsJson.comments) ? commentsJson.comments : [];

  const latestComments = comments
    .slice(0, 3)
    .reverse()
    .map((comment) => shortenText(comment.plain_body || comment.body || "", 1200))
    .join("\n\n");

  return {
    subject: shortenText(ticket.subject || "", 300),
    description: shortenText(ticket.description || "", 1800),
    commentsText: latestComments
  };
}

function formatTicketContextForPrompt(ticketContext) {
  return `
Betreff:
${ticketContext.subject || ""}

Beschreibung:
${ticketContext.description || ""}

Kommentare:
${ticketContext.commentsText || "Keine Kommentare gefunden."}
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
      ticketId = "",
      requesterName = ""
    } = req.body;

    const languageName = getLanguageName(targetLanguage);
    const greeting = getGreeting(targetLanguage, requesterName);
    const closing = getClosing(targetLanguage);

    let prompt = "";

    if (action === "summarize_ticket") {
      if (!ticketId) {
        return res.status(400).json({
          error: "Missing ticketId",
          details: "ticketId is required for summarize_ticket"
        });
      }

      const fullTicketContext = await buildTicketContext(ticketId);
      const promptContext = formatTicketContextForPrompt(fullTicketContext);

      prompt = `
You are a Zendesk support assistant for tutti.ch.

Create a SHORT and PRECISE internal summary in ${languageName}.

Rules:
Only bullet points.
Maximum 4 bullet points.
Each bullet maximum 1 sentence.
No intro text.
No conclusion.
No label like "Zusammenfassung".
Focus only on important facts.

Focus on:
problem
key data such as emails, accounts, phone numbers
what the customer wants

Ticket:
${promptContext}
`;
    } else if (action === "translate_summary") {
      prompt = `
Translate the following internal summary into ${languageName}.

Rules:
Keep the bullet structure.
Do not expand it.
Do not turn it into a customer reply.
Do not add greeting.
Do not add closing.

Text:
${text}
`;
    } else if (action === "reply_from_summary") {
      prompt = `
You are a tutti.ch support agent.

Write a clean customer reply in German based on the following internal summary.

Rules:
friendly
short
clear
no internal wording
no over-explaining

Use exactly this greeting:
${getGreeting("de", requesterName)}

Use exactly this closing:
${getClosing("de")}

Internal summary:
${text}
`;
    } else if (action === "improve_text") {
      prompt = `
You are a Zendesk support copilot.

Turn the following draft into a complete customer-facing support reply.

Rules:
Detect the language of the original text.
Keep the same language.
Rewrite it so it sounds professional, clear, polite and natural.
Return a complete reply, not just a corrected fragment.
Use exactly the correct standard greeting and closing for the detected language.
Do not add any agent name.
Do not add any extra signature.
Return only the final customer reply.

Customer name:
${requesterName}

German greeting:
${getGreeting("de", requesterName)}
German closing:
${getClosing("de")}

French greeting:
${getGreeting("fr", requesterName)}
French closing:
${getClosing("fr")}

Italian greeting:
${getGreeting("it", requesterName)}
Italian closing:
${getClosing("it")}

English greeting:
${getGreeting("en", requesterName)}
English closing:
${getClosing("en")}

Original text:
${text}
`;
    } else if (action === "translate_text") {
      prompt = `
You are a Zendesk support copilot.

Translate the following text into ${languageName}.

Rules:
Keep the meaning exactly.
If the text is a customer reply, return a full customer-ready reply with the appropriate greeting and closing.
If the text is not a customer reply, translate it naturally without inventing extra content.
Return only the final text.

For customer replies, use these templates.

German greeting:
${getGreeting("de", requesterName)}
German closing:
${getClosing("de")}

French greeting:
${getGreeting("fr", requesterName)}
French closing:
${getClosing("fr")}

Italian greeting:
${getGreeting("it", requesterName)}
Italian closing:
${getClosing("it")}

English greeting:
${getGreeting("en", requesterName)}
English closing:
${getClosing("en")}

Original text:
${text}
`;
    } else {
      return res.status(400).json({
        error: "Invalid action",
        details: "Unknown action"
      });
    }

    const output = await runPrompt(prompt);

    res.json({ output });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Backend error",
      details: error.message
    });
  }
});

app.listen(port, () => {
  console.log("Server running on port " + port);
});
