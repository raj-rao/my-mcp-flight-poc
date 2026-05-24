import { GoogleGenAI } from '@google/genai';
import crypto from 'crypto';

// Helper function to generate a JWT and swap it for a user-scoped Salesforce Access Token
async function getSalesforceUserToken() {
  const consumerKey = process.env.SF_CONSUMER_KEY;
  // Fallback to a target username; in production, this comes dynamically from your logged-in app session
  const username = 'rajrao104-3972@dev.org'; 
  const audience = 'https://login.salesforce.com';
  
  // 1. Build the JWT Header and Claim Set
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claimSet = Buffer.from(JSON.stringify({
    iss: consumerKey,
    sub: username,
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 180 // Token valid for 3 minutes
  })).toString('base64url');

  const signInput = `${header}.${claimSet}`;

  // 2. Sign the JWT using your private key generated with OpenSSL
  const privateKey = process.env.SF_PRIVATE_KEY.replace(/\\n/g, '\n'); // Clean any Vercel newline compression strings
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput);
  const signature = signer.sign(privateKey, 'base64url');

  const assertionToken = `${signInput}.${signature}`;

  // 3. Post the assertion to Salesforce OAuth Token Endpoint
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: assertionToken
  });

  const response = await fetch(`https://${process.env.SF_DOMAIN}.my.salesforce.com/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Salesforce JWT Handshake Failure: ${errorText}`);
  }

  const tokenData = await response.json();
  return tokenData.access_token;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'HTTP Method unsupported' });
  }

  try {
    // Fetch a user-specific token dynamically via JWT Bearer Flow
    const sfAccessToken = await getSalesforceUserToken();

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const aiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash', 
      contents: req.body.message,
      config: {
        systemInstruction: `You are an operational flight reservation coordinator agent. 
        You have absolute access to the user's secure CRM data through the connected Salesforce Invocable Actions MCP Server.
        
        CRITICAL DATE PARSING INSTRUCTIONS:
        When processing human date requests, extract the specific intent and strictly pass it into the 'dateFilter' variable as one of these alphanumeric keywords:
        - "Flights today" -> TODAY
        - "Trips next month" -> NEXT_MONTH
        - "This upcoming weekend" -> WEEKEND
        
        Always translate raw record structures (Name, Price__c, FlightId__c) back into conversational, friendly summaries for the webpage UI layout. Do not stop at explaining what you are searching; retrieve the data using your tools and present the final list.`,
        
        tools: [
          {
            mcp: {
              url: process.env.SALESFORCE_MCP_URL,
              // Inject the user-specific token directly into the tool gateway headers block
              headers: {
                Authorization: `Bearer ${sfAccessToken}`
              }
            }
          }
        ]
      }
    });

    return res.status(200).json({ reply: aiResponse.text });
  } catch (error) {
    console.error("Execution Crash Log: ", error.message);
    return res.status(500).json({ error: `Serverless Error: ${error.message}` });
  }
}