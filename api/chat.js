import { GoogleGenAI, mcpToTool } from '@google/genai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import crypto from 'crypto';

/**
 * Automatically generates a secure JWT assertion and exchanges it 
 * for a live, user-scoped Salesforce Access Token.
 */
async function getSalesforceUserToken() {
  const consumerKey = process.env.SF_CONSUMER_KEY;
  const audience = 'https://login.salesforce.com';
  
  // CRITICAL: Ensure this matches the exact username listed in your active Org farm instance profile!
  const username = 'rajrao104.e195a8a1a260@agentforce.com'; 

  // 1. Build the base64url encoded JWT structure
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claimSet = Buffer.from(JSON.stringify({
    iss: consumerKey,
    sub: username,
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 180 // Token lifespan: 3 minutes
  })).toString('base64url');

  const signInput = `${header}.${claimSet}`;
  
  // Clean up any newline compression artifacts injected by the Vercel dashboard environment text box
  const privateKey = process.env.SF_PRIVATE_KEY.replace(/\\n/g, '\n'); 
  
  // 2. Sign the payload using your local OpenSSL RSA private key asset
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput);
  const signature = signer.sign(privateKey, 'base64url');

  const assertionToken = `${signInput}.${signature}`;

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: assertionToken
  });

  // Sanitize the subdomain prefix string safely
  let domain = process.env.SF_DOMAIN.trim();
  domain = domain.replace(/^https?:\/\//, ''); 
  domain = domain.replace(/\.my\.salesforce-setup\.com\/?$/, '');

  // 3. Request the access token from your specific scratch org pod destination
  const response = await fetch(`https://${domain}.my.salesforce-setup.com/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Salesforce JWT Gateway Handshake Failure: ${errorText}`);
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

  let transport = null;
  let mcpClient = null;

  try {
    // Step 1: Secure a live user identity context token
    const sfAccessToken = await getSalesforceUserToken();

    // Step 2: Establish the foundational MCP Client Transport connection over SSE
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

    // Open communication tunnel to the remote Salesforce API Gateway
    await mcpClient.connect(transport);

    // Step 3: Map your active custom Apex classes dynamically into a Gemini-readable tool structure
    const salesforceGeminiTool = await mcpToTool(mcpClient);

    // Step 4: Initialize the core Google Gen AI Client SDK configuration
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
        
        tools: [salesforceGeminiTool]
      }
    });

    // Clean up connections immediately to eliminate Vercel runtime resource exhaustion logs
    await mcpClient.close();

    // Step 5: Safe object-drilling response parser to eliminate front-end 'undefined' errors
    let responsePayloadString = "";

    if (aiResponse && aiResponse.text) {
      responsePayloadString = aiResponse.text;
    } else if (aiResponse?.candidates?.[0]?.content?.parts?.[0]?.text) {
      responsePayloadString = aiResponse.candidates[0].content.parts[0].text;
    } else {
      responsePayloadString = "Search execution cleared cleanly, but no flight records matching that specific date criteria window were found under your user account profile layout.";
    }

    return res.status(200).json({ reply: responsePayloadString });

  } catch (error) {
    console.error("Serverless Operational Crash: ", error.message);
    
    // Explicit clean fallback check if the gateway faults before closing the protocol client
    if (mcpClient) {
      try { await mcpClient.close(); } catch (_) {}
    }
    
    return res.status(500).json({ error: `Internal Engine Execution Failure: ${error.message}` });
  }
}