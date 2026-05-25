import { GoogleGenAI } from '@google/genai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import crypto from 'crypto';

// 1. Static Tool Schema Declaration for Gemini's Intent Processing
const salesforceFlightTool = {
  functionDeclarations: [
    {
      name: "GetPastOrUpcomingTripsAction",
      description: "Fetches flight bookings from the Salesforce custom object database using the Model Context Protocol.",
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

/**
 * Main Vercel serverless function route orchestrator using pure MCP Protocol Client
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'HTTP Method unsupported' });
  }

  let transport = null;
  let mcpClient = null;

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    // Step 2: Prompt reasoning with our static functional schema framework
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

    // Step 3: Check if Gemini isolated a requirement to query your CRM database via MCP
    const call = aiResponse.functionCalls?.[0] || aiResponse?.candidates?.[0]?.content?.parts?.[0]?.functionCall;

    if (call && call.name === "GetPastOrUpcomingTripsAction") {
      const targetFilter = call.args.dateFilter || "NEXT_MONTH";

      // Secure our dynamic user identity context token
      const sfAccessToken = await getSalesforceUserToken();

      // Step 4: TRUE MCP PROTOCOL EXECUTION
      // Connect to the Salesforce hosted MCP Server using the official SDK Transport Layer
      transport = new SSEClientTransport(new URL(process.env.SALESFORCE_MCP_URL), {
        requestInit: {
          headers: {
            'Authorization': `Bearer ${sfAccessToken}`,
            'Content-Type': 'application/json'
          }
        }
      });

      mcpClient = new Client({
        name: "vercel-mcp-client-bridge",
        version: "1.0.0"
      }, { capabilities: {} });

      await mcpClient.connect(transport);

      // Execute the tool call strictly adhering to the official Model Context Protocol standard
      const mcpData = await mcpClient.request({
        method: "tools/call",
        params: {
          name: "GetPastOrUpcomingTripsAction",
          arguments: { 
            dateFilter: targetFilter,
            isPastTrip: false,
            bookingNumber: ""
          }
        }
      });

      // Clean up connection immediately
      await mcpClient.close();
      
      // Step 5: Feed the pure MCP server response back into Gemini for conversational output
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
    
    if (mcpClient) {
      try { await mcpClient.close(); } catch (_) {}
    }
    
    return res.status(200).json({ reply: `MCP Protocol Execution Error: ${error.message}` });
  }
}