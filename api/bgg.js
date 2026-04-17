export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send('missing url param');

  const decodedUrl = decodeURIComponent(url);
  res.setHeader('Access-Control-Allow-Origin', '*');

  const attempt = async () => {
    const response = await fetch(decodedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    return response.text();
  };

  try {
    let text = await attempt();

    // BGG returns a short "queued" message — retry once after a short delay
    if (text.length < 200 && text.includes('<message>')) {
      await new Promise(r => setTimeout(r, 2000));
      text = await attempt();
    }

    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    res.setHeader('X-Response-Length', text.length);
    res.status(200).send(text);
  } catch (e) {
    res.status(500).send('Proxy error: ' + e.message);
  }
}
