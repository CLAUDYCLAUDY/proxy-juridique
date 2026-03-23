module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, history } = req.body;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: `Tu es un assistant qui aide les gens à faire valoir leurs droits. Tu réponds en français de manière claire. Rappelle toujours que tes réponses sont informatives et ne remplacent pas une consultation professionnelle.`,
      messages: [...(history || []), { role: 'user', content: message }]
    })
  });

  const data = await response.json();
  if (data.error) return res.status(500).json({ error: data.error.message });
  res.status(200).json({ reply: data.content[0].text });
}
