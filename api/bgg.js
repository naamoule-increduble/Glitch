export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send('missing url param');

  console.log('[BGG proxy v3 live]');
  const decodedUrl = decodeURIComponent(url);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-BGG-Proxy-Version', 'v3');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/xml,text/xml,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://boardgamegeek.com/',
  };

  const attempt = async (targetUrl) => {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    console.log('[BGG proxy] URL:', targetUrl);
    console.log('[BGG proxy] status:', response.status);
    console.log('[BGG proxy] content-type:', contentType);
    console.log('[BGG proxy] body preview:', text.slice(0, 200));

    return { status: response.status, contentType, text };
  };

  try {
    let result = await attempt(decodedUrl);

    if (result.text.includes('<message>') && result.text.length < 300) {
      await new Promise(r => setTimeout(r, 2500));
      result = await attempt(decodedUrl);
    }

    if (result.text.includes('Unauthorized') && decodedUrl.includes('/xmlapi2/search')) {
      const v1Url = decodedUrl
        .replace('/xmlapi2/search?query=', '/xmlapi/search?search=')
        .replace('&type=boardgame', '');
      console.log('[BGG proxy] trying v1 fallback:', v1Url);
      result = await attempt(v1Url);
    }

    const blocked =
      result.text.includes('Unauthorized') ||
      result.text.toLowerCase().includes('access denied') ||
      result.text.toLowerCase().includes('request blocked') ||
      result.text.toLowerCase().includes('forbidden');

    if (blocked) {
      return res.status(502).send('BGG upstream blocked');
    }

    res.setHeader('Content-Type', result.contentType || 'application/xml; charset=utf-8');
    return res.status(200).send(result.text);
  } catch (e) {
    console.error('[BGG proxy] error:', e);
    return res.status(500).send('Proxy error: ' + e.message);
  }
}
