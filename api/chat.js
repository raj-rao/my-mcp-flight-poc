import { GoogleGenAI } from '@google/genai';
import crypto from 'crypto';

// 1. Static Tool Schema Declaration
// Bypasses resource-heavy SSE discovery handshakes to ensure execution completes under 10 seconds
const salesforceFlightTool = {
  functionDeclarations: [
    {
      name: "GetPastOrUpcomingTripsAction",
      description: "Fetches flight bookings from the Salesforce custom object database based on intent parameters.",
      parameters: {
        type: "OBJECT",
        properties: {
          dateFilter: {
            type: "STRING",
            description: "Alphanumeric filter keyword mapping the target timeline execution criteria window. Accepted values: TODAY, NEXT_MONTH, WEEKEND."
          }
        },
        required: ["dateFilter"]
      }
    }
  ]
};

/**
 * Automatically generates a secure JWT assertion and exchanges it 
 * for a live, user-scoped Salesforce Access Token.
 */
async function getSalesforceUserToken() {
  const consumerKey = process.env.SF_CONSUMER_KEY;
  const audience = 'https://login.salesforce.com';
  
  // Ensure this matches your login username string inside your Salesforce Org farm profile
  const username = 'rajrao104.e195a8a1a260@agentforce.com'; 

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claimSet = Buffer.from(JSON.stringify({
    iss: consumerKey,
    sub: username,
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 180 
  })).toString('base64url');

  const signInput = `${header}.${claimSet}`;
  const privateKey = process.env.SF_PRIVATE_KEY.replace(/\\n/g, '\n'); 
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput);
  const signature = signer.sign(privateKey, 'base64url');

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${signInput}.${signature}`
  });

  let domain = process.env.SF_DOMAIN.trim().replace(/^https?:\/\//, '').replace(/\.my\.salesforce-setup\.com\/?$/, '');

  const response = await fetch(`https://${domain}.my.salesforce-setup.com/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!response.ok) {
    throw new Error(`Salesforce Token Request Rejected: ${await response.text()}`);
  }

  const tokenData = await response.json();
  return tokenData.access_token;
}

/**
 * Main Vercel serverless function route orchestrator.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'HTTP Method unsupported' });
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    // Step 2: Run prompt reasoning with our static functional schema framework
    const aiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash', 
      contents: req.body.message,
      config: {
        systemInstruction: `You are an operational flight reservation coordinator agent. 
        You have direct access to run custom actions. If the user asks for flights, look for the date criteria and immediately invoke 'GetPastOrUpcomingTripsAction'.
        
        CRITICAL DATE PARSING INSTRUCTIONS:
        Extract the human intent window and pass it to the parameter array:
        - "Flights today" -> TODAY
        - "Trips next month" -> NEXT_MONTH
        - "This upcoming weekend" -> WEEKEND`,
        tools: [salesforceFlightTool]
      }
    });

    // Step 3: Check if Gemini isolated a requirement to query your CRM database
    const call = aiResponse.functionCalls?.[0] || aiResponse?.candidates?.[0]?.content?.parts?.[0]?.functionCall;

    if (call && call.name === "GetPastOrUpcomingTripsAction") {
      const targetFilter = call.args.dateFilter || "NEXT_MONTH";

      // Secure our dynamic user identity context token
      const sfAccessToken = await getSalesforceUserToken();

      // Step 4: Execute a direct, highly optimized POST request using a strict JSON-RPC structure
      const mcpResponse = await fetch(process.env.SALESFORCE_MCP_URL, {
        method: 'POST', 
        headers: {
          'Authorization': `Bearer ${sfAccessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "GetPastOrUpcomingTripsAction",
            arguments: { 
              inputRecords: [
                {
                  dateFilter: targetFilter,
                  isPastTrip: false,
                  bookingNumber: ""
                }
              ]
            }
          },
          id: 1
        })
      });

      if (!mcpResponse.ok) {
        return res.status(200).json({ reply: `Connected to Salesforce gateway, but the target custom class threw an internal exception: ${mcpResponse.statusText}` });
      }

      const mcpData = await mcpResponse.json();
      
      // Step 5: Feed the direct Salesforce record result back into Gemini for conversational output
      const finalResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          { role: 'user', parts: [{ text: req.body.message }] },
          { role: 'model', parts: [{ functionCall: call }] },
          { role: 'user', parts: [{ text: `Tool result payload data: ${JSON.stringify(mcpData)}` }] }
        ]
      });

      return res.status(200).json({ reply: finalResponse.text || "Flight database data found, but layout parsing dropped." });
    }

    // Default conversational response if no functional lookup was triggered
    return res.status(200).json({ reply: aiResponse.text || "No actionable request isolated." });

  } catch (error) {
    console.error("Crash Tracking System Log:", error.message);
    // Returning a clean object to the frontend prevents 'undefined' message banners
    return res.status(200).json({ reply: `System encounter error during execution: ${error.message}` });
  }
}