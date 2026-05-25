import { GoogleGenAI } from '@google/genai';
import crypto from 'crypto';

// 1. Pure Model Context Protocol (MCP) Static Tool Schema Representation
const salesforceFlightTool = {
  functionDeclarations: [
    {
      name: "GetPastOrUpcomingTripsAction",
      description: "Fetches flight bookings from the Salesforce custom object database using the Model Context Protocol specification.",
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'HTTP Method unsupported' });
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    // Step 2: Prompt reasoning with our functional framework schema
    const aiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash', 
      contents: req.body.message,
      config: {
        systemInstruction: `You are an operational flight reservation coordinator agent. 
        You have direct access to run custom actions via the Model Context Protocol. If the user asks for flights, invoke 'GetPastOrUpcomingTripsAction'.
        
        CRITICAL DATE PARSING INSTRUCTIONS:
        Extract the human intent window and pass it to the parameter array:
        - "Flights today" -> TODAY
        - "Trips next month" -> NEXT_MONTH
        - "This upcoming weekend" -> WEEKEND`,
        tools: [salesforceFlightTool]
      }
    });

    const call = aiResponse.functionCalls?.[0] || aiResponse?.candidates?.[0]?.content?.parts?.[0]?.functionCall;

    if (call && call.name === "GetPastOrUpcomingTripsAction") {
      const targetFilter = call.args.dateFilter || "NEXT_MONTH";
      const sfAccessToken = await getSalesforceUserToken();

      // Step 4: VALIDATE THE MCP SPECIFICATION VIA DIRECT HANDSHAKE
      // To bypass Vercel chunk-splitting stream bugs, we communicate with the MCP gateway 
      // using a complete, atomic payload transaction that fully models the tools/call method.
      const mcpResponse = await fetch(process.env.SALESFORCE_MCP_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sfAccessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "GetPastOrUpcomingTripsAction",
            arguments: { 
              dateFilter: targetFilter,
              isPastTrip: false,
              bookingNumber: ""
            }
          },
          id: 1
        })
      });

      if (!mcpResponse.ok) {
        const errText = await mcpResponse.text();
        return res.status(200).json({ reply: `MCP Server rejected the tool request payload execution: ${errText}` });
      }

      const mcpData = await mcpResponse.json();
      
      // Step 5: Feed the pure MCP response data payload back to Gemini for conversational layout rendering
      const finalResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          { role: 'user', parts: [{ text: req.body.message }] },
          { role: 'model', parts: [{ functionCall: call }] },
          { role: 'user', parts: [{ text: `MCP Server tool result payload data: ${JSON.stringify(mcpData)}` }] }
        ]
      });

      return res.status(200).json({ reply: finalResponse.text || "Flight database data found via MCP, but layout parsing dropped." });
    }

    return res.status(200).json({ reply: aiResponse.text || "No actionable request isolated." });

  } catch (error) {
    console.error("MCP Protocol Operational Fault:", error.message);
    return res.status(200).json({ reply: `MCP Protocol Execution Error: ${error.message}` });
  }
}