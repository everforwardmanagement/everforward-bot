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

// Google Docs setup
const docs = google.docs({
  version: 'v1',
  auth: process.env.GOOGLE_API_KEY,
});

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

// Function to search the web using Claude's web search
async function searchWeb(query) {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: `Search the web for information about: ${query}\n\nProvide a brief, factual answer.`,
        },
      ],
    });
    return response.content[0].type === 'text' ? response.content[0].text : '';
  } catch (error) {
    console.error('Error with web search:', error);
    return '';
  }
}

// Main message handler
app.message(async ({ message, say, client: slackClient }) => {
  // Only respond to app mentions
  if (!message.text || !message.text.includes('<@U')) {
    return;
  }

  try {
    // Show that bot is processing
    await say('🤔 Looking that up for you...');

    // Extract the question (remove bot mention)
    const question = message.text.replace(/<@U[A-Z0-9]+>/g, '').trim();

    if (!question) {
      await say('Please ask me a question! For example: "What are the commission rates?" or "How do I request time off?"');
      return;
    }

    // Get training document content
    const docId = process.env.GOOGLE_DOC_ID;
    const trainingContent = await getGoogleDocContent(docId);

    // Use Claude to answer from training doc first, then web if needed
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

    const answer = response.content[0].type === 'text' ? response.content[0].text : 'I could not find an answer to that question.';

    // Format the response nicely
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Question:* ${question}\n\n*Answer:*\n${answer}`,
        },
      },
    ];

    // Update the "looking that up" message with the answer
    await slackClient.chat.update({
      channel: message.channel,
      ts: message.ts,
      blocks: blocks,
      text: answer, // Fallback for older Slack clients
    });
  } catch (error) {
    console.error('Error processing message:', error);
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
