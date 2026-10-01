// Serves the demo front end and hosts every environment's BFF on one origin (no CORS needed).
//
//   node demo/app-server.mjs        (or: npm run app)  →  http://localhost:8090
//
//   /                                         the front end (demo/app/)
//   /bff/<env>/bootstrap/v1/localisation/<tag> that environment's BFF (option B pass-through)
//   /base/<en-US|fr-FR>.json                   stands in for the base files compiled into the app (D6)
//   /config.json                               environments, allowlists, site and repository
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createBffHandler, loadConfig } from '../bff/bff.mjs';

const config = loadConfig();
const port = Number(process.env.PORT ?? 8090);
const handlers = Object.fromEntries(Object.values(config.environments).map(e => [e.env, createBffHandler(e)]));
const STATIC = {
  '/': ['app/index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app/app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app/app.js', 'text/javascript; charset=utf-8'],
};

const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://app');

  const bff = /^\/bff\/([a-z]+)(\/.*)$/.exec(url.pathname);
  if (bff) {
    const handler = handlers[bff[1]];
    if (!handler) return send(res, 404, 'application/json', JSON.stringify({ error: 'unknown_environment' }));
    req.url = bff[2] + url.search;
    return handler(req, res);
  }

  if (url.pathname === '/config.json') {
    const environments = Object.fromEntries(Object.values(config.environments).map(e => [e.env, { tags: e.tags }]));
    return send(res, 200, 'application/json', JSON.stringify({ repo: config.repo, siteUrl: config.siteUrl, environments }));
  }

  const base = /^\/base\/(en-US|fr-FR)\.json$/.exec(url.pathname);
  if (base) return send(res, 200, 'application/json; charset=utf-8', await readFile(new URL(`../i18n/${base[1]}.json`, import.meta.url)));

  if (url.pathname === '/favicon.ico') return send(res, 204, 'image/x-icon', '');

  const file = STATIC[url.pathname];
  if (file) return send(res, 200, file[1], await readFile(new URL(file[0], import.meta.url)));

  send(res, 404, 'text/plain', 'Not found');
}).listen(port, () => {
  console.log(`Demo app: http://localhost:${port}`);
  console.log(`Site:     ${config.siteUrl}`);
  console.log('BFF log:');
});
