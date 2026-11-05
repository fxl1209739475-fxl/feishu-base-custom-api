// Node >= 22. Fixed OpenAI upstream; never accepts upstream URLs or keys from clients.
const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
function createProxy({apiKey, token, origins, fetcher = fetch, maxBytes = 52 * 1024 * 1024}) {
  if (!apiKey || !token || token.length < 32 || !origins?.length || origins.includes('*')) throw Error('配置 OPENAI_API_KEY、至少32字符的 PROXY_TOKEN 和明确的 ALLOWED_ORIGINS');
  let active = 0;
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const reply = (status, message) => { res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'}); res.end(JSON.stringify({error:{message}})); };
    if (!origins.includes(origin)) return reply(403, 'Origin denied');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (!['/v1/images/edits','/v1/images/generations'].includes(req.url)) return reply(404, 'Not found');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'}); return res.end();
    }
    if (req.method !== 'POST') return reply(405, 'POST required');
    const auth = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from('Bearer ' + token);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(401, 'Invalid proxy token');
    if (active >= 2) return reply(429, 'Proxy busy; retry manually');
    active++;
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 300000);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > maxBytes) { reply(413, 'Request too large'); return; } chunks.push(chunk); }
      const type = req.headers['content-type'] || '';
      const raw = Buffer.concat(chunks);
      const edit = req.url.endsWith('/edits');
      let data, body;
      const headers = {Authorization:'Bearer ' + apiKey};
      if (edit) {
        if (!type.startsWith('multipart/form-data;')) return reply(415,'Edits require multipart/form-data');
        data = await new Request('http://localhost', {method:'POST', headers:{'Content-Type':type}, body:raw}).formData();
        const allowed = new Set(['model','prompt','size','n','output_format','image[]']);
        if ([...data.keys()].some(k=>!allowed.has(k))) return reply(400,'Unsupported edit field');
        const images = data.getAll('image[]');
        if (!images.length || images.length > 16 || images.some(i=> typeof i === 'string' || !['image/png','image/jpeg','image/webp'].includes(i.type) || !i.size || i.size >= 50*1024*1024)) return reply(400,'Invalid reference images');
        body = data;
      } else {
        if (!type.startsWith('application/json')) return reply(415,'JSON required');
        data = JSON.parse(raw.toString());
        if (Object.keys(data).some(k=>!['model','prompt','size','n','output_format'].includes(k))) return reply(400,'Unsupported generation field');
        body = JSON.stringify(data); headers['Content-Type']='application/json';
      }
      const get = k => edit ? data.get(k) : data[k];
      if (get('model') !== 'gpt-image-2' || String(get('n')) !== '1' || get('output_format') !== 'png' || !['1024x1024','1024x1536','1536x1024'].includes(get('size')) || typeof get('prompt') !== 'string' || !get('prompt').trim() || get('prompt').length > 32000) return reply(400,'Invalid model, prompt, size or output options');
      const upstream = await fetcher('https://api.openai.com' + req.url, {method:'POST', headers, body, signal:controller.signal, redirect:'error'});
      // Do not forward upstream errors, headers or credentials to browser/logs.
      if (!upstream.ok) return reply(upstream.status, 'OpenAI request failed; check account permissions, quota and parameters');
      const result = await upstream.json();
      if (!result.data?.[0]?.b64_json) return reply(502,'OpenAI response missing image');
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({data:[{b64_json:result.data[0].b64_json}]}));
    } catch (e) { if (!res.headersSent) reply(e.name === 'AbortError' ? 504 : 502, 'Image proxy request failed; no automatic retry'); }
    finally { clearTimeout(timer); active--; }
  });
}
if (require.main === module) {
  const server = createProxy({apiKey:process.env.OPENAI_API_KEY, token:process.env.PROXY_TOKEN, origins:(process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean)});
  server.requestTimeout = 60000;
  server.listen(Number(process.env.PORT || 8787), '127.0.0.1', ()=>console.log('Image proxy listening on loopback; expose through authenticated HTTPS ingress'));
}
module.exports = {createProxy};
