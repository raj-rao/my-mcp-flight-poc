import { GoogleGenAI } from '@google/genai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import crypto from 'crypto';

// Custom MCP Transport Layer to bypass the SDK's hardcoded GET streaming constraints
class CustomPostSSETransport {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
  }

  async start() {
    // Force the initial connection handshake to run as an authenticated POST request
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "custom-bridge", version: "1.0.0" } }, id: 0 })
    });

    if (!response.ok) {
      throw new Error(`MCP Gateway rejected connection: ${response.status} (${response.statusText})`);
    }

    // Process the stream responses continuously over the secure POST channel
    this.readStream(response.body.getReader());
  }

  async readStream(reader) {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        if (this.onmessage) {
          this.onmessage({ data: chunk });
        }
      }
    } catch (err) {
      if (this.onerror) this.onerror(err);
    } finally {
      if (this.onclose) this.onclose();
    }
  }

  async send(message) {
    // Ensure all individual tool execution commands utilize POST
    await fetch(this.url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(message)
    });
  }

  async close() {
    if (this.onclose) this.onclose();
  }
}

// Static Tool Schema Declaration for Gemini
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
  if (req.method !== 'POST') return res.status(405).end();

  let mcpClient = null;

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const aiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash', 
      contents: req.body.message,
      config: {
        systemInstruction: `You are an operational flight reservation coordinator agent. 
        You have direct access to run custom actions via MCP. If the user asks for flights, invoke 'GetPastOrUpcomingTripsAction'.
        
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

      // Step 4: INITIALIZE OUR CUSTOM POST-ONLY TRANSPORT LAYER
      const transport = new CustomPostSSETransport(process.env.SALESFORCE_MCP_URL, sfAccessToken);

      mcpClient = new Client({
        name: "vercel-mcp-client-bridge",
        version: "1.0.0"
      }, { capabilities: {} });

      // Run our pure protocol connect loop safely using POST mechanics
      await mcpClient.connect(transport);

      // Fire a strictly formatted JSON-RPC request down the compliant client path
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

      await mcpClient.close();
      
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
    console.error("MCP Custom Protocol Operational Fault:", error.message);
    if (mcpClient) {
      try { await mcpClient.close(); } catch (_) {}
    }
    return res.status(200).json({ reply: `MCP Protocol Execution Error: ${error.message}` });
  }
}