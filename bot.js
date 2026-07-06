const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
require('dotenv').config();

// Initialize Slack app with Socket Mode
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Initialize Anthropic client
const client = new Anthropic();

// Google Docs setup — authenticate with a service account.
// The service account's JSON key is stored in the GOOGLE_SERVICE_ACCOUNT
// environment variable (as a single-line JSON string), NOT committed to the repo.
function getGoogleAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT env variable is not set');
  }
  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/documents.readonly'],
  });
}

const auth = getGoogleAuth();
const docs = google.docs({ version: 'v1', auth });

// Function to fetch Google Doc content
async function getGoogleDocContent(docId) {
  try {
    const response = await docs.documents.get({
      documentId: docId,
    });

    // Extract text from the document
    let fullText = '';
    if (response.data.body && response.data.body.content) {
      response.data.body.content.forEach((element) => {
        if (element.paragraph && element.paragraph.elements) {
          element.paragraph.elements.forEach((el) => {
            if (el.textRun && el.textRun.content) {
              fullText += el.textRun.content;
            }
          });
          fullText += '\n';
        }
      });
    }
    return fullText;
  } catch (error) {
    console.error('Error fetching Google Doc:', error);
    return null;
  }
}

// Shared logic: takes a raw question string, returns the answer text.
async function answerQuestion(question) {
  const docId = process.env.GOOGLE_DOC_ID;
  const trainingContent = await getGoogleDocContent(docId);

  const systemPrompt = `You are a helpful assistant for Everforward Management, a sales recruiting agency that partners with AT&T.

You have access to an internal training document that contains company SOPs, policies, commission structures, training materials, and product knowledge.

Answer questions based on this training document. If the answer is not in the training document, search the web for AT&T product information or other relevant details.

Format your answers clearly:
- For how-to questions: provide step-by-step instructions
- For policy questions: be clear and concise
- For product questions: provide factual information
- Always cite where you found the information (training doc or web)

Training Document Content:
${trainingContent ? trainingContent.substring(0, 4000) : 'Document not available'}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Question: ${question}`,
      },
    ],
  });

  return response.content[0].type === 'text'
    ? response.content[0].text
    : 'I could not find an answer to that question.';
}

// Core handler shared by both mentions and DMs.
async function handleIncomingMessage({ rawText, channel, say, slackClient, isMention }) {
  const question = isMention
    ? rawText.replace(/<@U[A-Z0-9]+>/g, '').trim()
    : (rawText || '').trim();

  if (!question) {
    await say('Please ask me a question! For example: "What are the commission rates?" or "How do I request time off?"');
    return;
  }

  const placeholder = await say('🤔 Looking that up for you...');
  const placeholderTs = placeholder.ts;

  const answer = await answerQuestion(question);

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Question:* ${question}\n\n*Answer:*\n${answer}`,
      },
    },
  ];

  await slackClient.chat.update({
    channel: channel,
    ts: placeholderTs,
    blocks: blocks,
    text: answer,
  });
}

// Handler for @mentions in channels.
app.event('app_mention', async ({ event, say, client: slackClient }) => {
  try {
    await handleIncomingMessage({
      rawText: event.text,
      channel: event.channel,
      say,
      slackClient,
      isMention: true,
    });
  } catch (error) {
    console.error('Error processing mention:', error);
    await say('Sorry, I encountered an error. Please try again.');
  }
});

// Handler for direct messages to the bot.
app.message(async ({ message, say, client: slackClient }) => {
  if (message.channel_type !== 'im') return;
  if (message.subtype !== undefined) return;
  if (message.bot_id) return;

  try {
    await handleIncomingMessage({
      rawText: message.text,
      channel: message.channel,
      say,
      slackClient,
      isMention: false,
    });
  } catch (error) {
    console.error('Error processing DM:', error);
    await say('Sorry, I encountered an error. Please try again.');
  }
});

// Handle errors
app.error(async (error) => {
  console.error('Slack app error:', error);
});

// Start the app
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('✅ Everforward Bot is running!');
})();
