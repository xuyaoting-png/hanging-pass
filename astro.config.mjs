// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  // 关掉 Astro 自带的 dev toolbar：它会明显拖慢帧率（实测首页 2fps ↔ 关闭后 50fps+），
  // 帧率被压到个位数时，吊牌翻转与滚动形变会被误判成 bug。
  devToolbar: { enabled: false },
  build: { inlineStylesheets: 'auto' },
});
