export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // HARDCODED BYPASS: Completely remove Gemini to save quota
  const sfAccessToken = (process.env.SF_TEMP_ACCESS_TOKEN || "").trim();
  let mcpEndpoint = (process.env.SALESFORCE_MCP_URL || "").replace(/['"]/g, '').trim();
  if (!mcpEndpoint.startsWith('http')) mcpEndpoint = `https://${mcpEndpoint}`;

  try {
    // 1. MCP Initialization
    const initResponse = await fetch(mcpEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sfAccessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'User-Agent': 'Vercel-MCP-Bridge/1.0',
        'Origin': 'https://api.salesforce.com'
      },
      body: JSON.stringify({
        jsonrpc: "2.0", 
        method: "initialize", 
        id: 1, 
        params: { 
          protocolVersion: "2024-11-05", 
          capabilities: {}, 
          clientInfo: { 
            name: "Salesforce-MCP-Client", // Matches the expected internal client naming
            version: "1.0.0" 
          } 
        }
      })
    });

    if (!initResponse.ok) return res.status(200).json({ reply: `Init Failed: ${await initResponse.text()}` });

    const mcpSessionId = initResponse.headers.get('mcp-session-id');
    
    // 2. Direct Tool Execution (No Gemini needed!)
    const mcpResponse = await fetch(mcpEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sfAccessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'mcp-session-id': mcpSessionId
      },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "tools/call", id: 2,
        params: {
          name: "GetPastOrUpcomingTripsAction",
          arguments: { inputs: [{ dateFilter: "NEXT_MONTH", isPastTrip: false, bookingNumber: "" }] }
        }
      })
    });

    const mcpData = await mcpResponse.json();
    return res.status(200).json({ reply: `MCP Success! Payload: ${JSON.stringify(mcpData)}` });

  } catch (error) {
    return res.status(500).json({ reply: `Crash: ${error.message}` });
  }
}