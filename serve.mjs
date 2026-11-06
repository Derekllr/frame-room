import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
createServer(async (request, response) => {
  const route = request.url.split('?')[0];
  const photo = /^\/demo\/\d+\.jpg$/.test(route);
  if (!photo && !['/', '/index.html'].includes(route)) {
    response.writeHead(404); response.end('Not found'); return;
  }
  try {
    const asset = await readFile(new URL('./dist' + (photo ? route : '/index.html'), import.meta.url));
    response.writeHead(200, {'Content-Type':photo ? 'image/jpeg' : 'text/html; charset=utf-8', 'Cache-Control':'no-store'});
    response.end(asset);
  } catch {
    response.writeHead(500); response.end('Run npm run build first.');
  }
}).listen(4174, '127.0.0.1', () => console.log('Local: http://127.0.0.1:4174/'));
