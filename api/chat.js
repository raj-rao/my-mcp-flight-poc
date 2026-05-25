import { GoogleGenAI } from '@google/genai';

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

async function getSalesforceUserToken() {
  const consumerKey = process.env.SF_CONSUMER_KEY;
  const refreshToken = process.env.SF_REFRESH_TOKEN; 
  
  let baseUrl = process.env.SF_DOMAIN.trim().replace(/\/$/, '');
  if (!baseUrl.startsWith('http')) {
    baseUrl = `https://${baseUrl}`;
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: consumerKey,
    refresh_token: refreshToken
  });

  const response = await fetch(`${baseUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!response.ok) {
    throw new Error(`OAuth Rejected: ${await response.text()}`);
  }

  const tokenData = await response.json();
  return tokenData.access_token;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'HTTP Method unsupported' });
  }

  // --- THE TRACER BULLET ---
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
      const sfAccessToken = await getSalesforceUserToken();

      let mcpEndpoint = process.env.SALESFORCE_MCP_URL || "";
      mcpEndpoint = mcpEndpoint.trim();
      if (!mcpEndpoint.startsWith('http')) {
        mcpEndpoint = `https://${mcpEndpoint}`;
      }
      
      executionStep = `Network Call 3: MCP Handshake to URL (${mcpEndpoint})`;
      const initResponse = await fetch(mcpEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sfAccessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream' 
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
          'mcp-session-id': mcpSessionId 
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
    // We now return EXACTLY where the crash happened
    console.error(`Crash at [${executionStep}]:`, error.message);
    return res.status(200).json({ reply: `CRITICAL CRASH at [${executionStep}] — Error Details: ${error.message}` });
  }
}