import { GoogleGenAI } from '@google/genai';

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
            description: "Intent: TODAY, TOMORROW, WEEKEND, LAST_MONTH, NEXT_MONTH, RANGE, NONE"
          }
        },
        required: ["dateFilter"]
      }
    }
  ]
};

/**
 * Uses a securely stored Refresh Token to mint a live, user-scoped 
 * Salesforce Access Token on the fly via standard OAuth 2.0 PKCE.
 */
async function getSalesforceUserToken() {
  const consumerKey = (process.env.SF_CONSUMER_KEY || "").trim();
  const consumerSecret = (process.env.SF_CONSUMER_SECRET || "").trim(); 
  const refreshToken = (process.env.SF_REFRESH_TOKEN || "").trim();
  
  // Bring back the aggressive Domain sanitizer to hit your specific orgfarm instance
  let rawDomain = (process.env.SF_DOMAIN || "").replace(/['"]/g, '').trim().replace(/\/$/, '');
  if (!rawDomain.startsWith('http')) {
    rawDomain = `https://${rawDomain}`;
  }

  // Route specifically to the isolated Agentforce environment, not the global gateway
  const tokenUrl = `${rawDomain}/services/oauth2/token`;

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: consumerKey,
    client_secret: consumerSecret, // Keep the required secret
    refresh_token: refreshToken
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString() 
  });

  if (!response.ok) {
    throw new Error(`OAuth Rejected by Instance: ${await response.text()}`);
  }

  const tokenData = await response.json();
  return tokenData.access_token;
}
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'HTTP Method unsupported' });
  }

  // --- EXECUTION TRACER ---
  // Tracks exactly where the container is during processing for pinpoint debugging
  let executionStep = "Initializing Container Environment";

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    executionStep = "Network Call 1: Gemini Intent Parsing";
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
      
      executionStep = "Network Call 2: Minting Salesforce OAuth PKCE Token";
      
      // BYPASS: Comment out the OAuth fetch
      //const sfAccessToken = await getSalesforceUserToken();
      const sfAccessToken = (process.env.SF_TEMP_ACCESS_TOKEN || "").trim(); 

      // Sanitize the MCP Gateway URL to prevent Node.js network crashes
      let mcpEndpoint = (process.env.SALESFORCE_MCP_URL || "").replace(/['"]/g, '').trim();
      if (!mcpEndpoint.startsWith('http')) {
        mcpEndpoint = `https://${mcpEndpoint}`;
      }
      
      executionStep = `Network Call 3: MCP Handshake to URL (${mcpEndpoint})`;
      const initResponse = await fetch(mcpEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sfAccessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream' // Required to avoid 406 Not Acceptable
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: { 
            protocolVersion: "2024-11-05", 
            capabilities: {}, 
            clientInfo: { name: "vercel-mcp-bridge", version: "1.0.0" } 
          },
          id: 1
        })
      });

      if (!initResponse.ok) {
        return res.status(200).json({ reply: `MCP Initialization Failed: ${await initResponse.text()}` });
      }

      const mcpSessionId = initResponse.headers.get('mcp-session-id');
      if (!mcpSessionId) {
        return res.status(200).json({ reply: "MCP Gateway did not return a session ID header." });
      }

      executionStep = `Network Call 4: MCP JSON-RPC Tool Execution (Session ID: ${mcpSessionId})`;
      const mcpResponse = await fetch(mcpEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sfAccessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'mcp-session-id': mcpSessionId // Links the atomic call to the established session
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "GetPastOrUpcomingTripsAction",
            arguments: { 
              // CRITICAL SCHEMA FIX: Wrapping parameters inside the expected invocable 'inputs' array
              inputs: [
                {
                  dateFilter: targetFilter,
                  isPastTrip: false,
                  bookingNumber: ""
                }
              ]
            }
          },
          id: 2
        })
      });

      if (!mcpResponse.ok) {
        return res.status(200).json({ reply: `MCP Server rejected the tool request: ${await mcpResponse.text()}` });
      }

      const mcpData = await mcpResponse.json();
      
      executionStep = "Network Call 5: Gemini Final Summarization";
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
    console.error(`Crash at [${executionStep}]:`, error.message);
    return res.status(200).json({ reply: `CRITICAL CRASH at [${executionStep}] — Error Details: ${error.message}` });
  }
}