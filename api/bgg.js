export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send('missing url param');

  try {
    const response = await fetch(decodeURIComponent(url), {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const text = await response.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    res.status(200).send(text);
  } catch (e) {
    res.status(500).send('Proxy error: ' + e.message);
  }
}
