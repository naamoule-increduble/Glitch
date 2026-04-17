export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send('missing url param');

  const decodedUrl = decodeURIComponent(url);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');

  // Full browser fingerprint — BGG blocks requests without these
  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://boardgamegeek.com/',
    'Origin': 'https://boardgamegeek.com',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };

  const attempt = async (targetUrl) => {
    const response = await fetch(targetUrl, {
      headers: browserHeaders,
      redirect: 'follow',
    });
    const text = await response.text();
    console.log(`BGG [${response.status}] ${targetUrl.slice(0, 80)} → ${text.length} chars`);
    return { status: response.status, text };
  };

  try {
    let { status, text } = await attempt(decodedUrl);

    // BGG sometimes queues requests — retry once after delay
    if (text.includes('<message>') && text.length < 300) {
      await new Promise(r => setTimeout(r, 2500));
      ({ status, text } = await attempt(decodedUrl));
    }

    // If still unauthorized, try v1 API as fallback (search only)
    if (text.includes('Unauthorized') && decodedUrl.includes('/xmlapi2/search')) {
      const v1Url = decodedUrl
        .replace('/xmlapi2/search?query=', '/xmlapi/search?search=')
        .replace('&type=boardgame', '');
      console.log('Trying BGG v1 API:', v1Url);
      ({ status, text } = await attempt(v1Url));
    }

    res.status(200).send(text);
  } catch (e) {
    console.error('BGG proxy error:', e.message);
    res.status(500).send('Proxy error: ' + e.message);
  }
}
