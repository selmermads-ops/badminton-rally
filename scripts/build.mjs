import { cp, mkdir, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const path of ['index.html', 'robots.txt', 'sitemap.xml', 'googlef9f8fe051900093e.html', 'affiliate']) {
  await cp(path, `dist/${path}`, { recursive: true });
}
