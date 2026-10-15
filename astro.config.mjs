// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages 的项目型站点跑在子路径下（…github.io/hanging-pass/），
// 所以只有在 CI 里才加 base —— 本地开发保持根路径干净。
const pages = process.env.GITHUB_PAGES === '1';

export default defineConfig({
  // 关掉 Astro 自带的 dev toolbar：它会明显拖慢帧率（实测首页 2fps ↔ 关闭后 50fps+），
  // 帧率被压到个位数时，吊牌翻转与滚动形变会被误判成 bug。
  devToolbar: { enabled: false },
  site: pages ? 'https://xuyaoting-png.github.io' : undefined,
  base: pages ? '/hanging-pass' : undefined,
  // 样式全部内联：这样字体用相对路径 url('fonts/…') 也能在任意 base 下解析对
  build: { inlineStylesheets: 'always' },
});
