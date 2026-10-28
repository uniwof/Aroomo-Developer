/**
 * LobeHub 返回的 HTML 文档：注入 Aroomo 的 CSS / JS，替换品牌名和图标链接。
 * 只处理 HTML 文档（SPA 外壳，很小），JS / CSS / 接口原样转发，不改上游任何文件（D69）。
 */
import { BRAND_FROM, BRAND_TO } from './rules.js';

export const ASSET_VERSION = '1';

export function headSnippet(version = ASSET_VERSION): string {
  return [
    '<meta name="application-name" content="Aroomo">',
    '<meta name="apple-mobile-web-app-title" content="Aroomo">',
    `<link rel="stylesheet" href="/aroomo/static/shell.css?v=${version}">`,
    // 同步脚本，放在 <head> 最前：要在 LobeHub 的代码运行前禁用朗读（D68）
    `<script src="/aroomo/static/shell.js?v=${version}"></script>`,
  ].join('');
}

export function transformHtml(html: string): string {
  let out = html.replace(BRAND_FROM, BRAND_TO);
  // 图标：一律换成 Aroomo 的（上游带 ?v= 参数，整段替换）
  out = out
    .replace(/(href=")\/favicon[^"]*\.ico(\?[^"]*)?"/g, '$1/aroomo/static/favicon.ico"')
    .replace(/(href=")\/apple-touch-icon[^"]*"/g, '$1/aroomo/static/apple-touch-icon.png"')
    .replace(/(href=")\/manifest\.json[^"]*"/g, '$1/aroomo/static/manifest.json"');
  const snippet = headSnippet();
  const m = /<head[^>]*>/i.exec(out);
  if (m) return out.slice(0, m.index + m[0].length) + snippet + out.slice(m.index + m[0].length);
  return snippet + out;
}
