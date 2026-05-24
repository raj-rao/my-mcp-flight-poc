import { GoogleGenAI } from '@google/genai';

// Instantiates the core client library using the Vercel backend ecosystem variables
const ai = new GoogleGenAI();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'HTTP Method mapping unsupported' });
  }

  const { message } = req.body;

  try {
    const aiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash', // The optimized performance standard for zero-latency tool tracking
      contents: message,
      config: {
        systemInstruction: `You are an operational flight reservation coordinator agent. 
        You have absolute access to the user's secure CRM data through the connected Salesforce Invocable Actions MCP Server.
        
        CRITICAL DATE PARSING INSTRUCTIONS:
        When processing human date requests, extract the specific intent and strictly pass it into the 'dateFilter' variable as one of these alphanumeric keywords:
        - "Flights today" -> NEXT_MONTH
        - "Trips next month" -> NEXT_MONTH
        - "This upcoming weekend" -> WEEKEND
        
        Always translate raw record structures (Name, Price__c, FlightId__c) back into conversational, friendly summaries for the webpage UI layout.`,
      }
    });

    return res.status(200).json({ reply: aiResponse.text });
  } catch (error) {
    return res.status(500).json({ error: `Serverless Execution Failure: ${error.message}` });
  }
}