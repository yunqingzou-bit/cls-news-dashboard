# 你的仓库中的 GetMoney

本目录复制自公开项目 `XiaoRongwen/stock_ai_getmoney`，保留其前端、Express 后端、财联社电报抓取、SSE、豆包 ARK 分析、每日报告、新闻联播分析和 JWT/VIP 逻辑。

## 与当前看板的关系

- 前端入口：`client/`，可部署到 GitHub Pages 或其他静态托管。
- 后端入口：`server/`，必须部署到 Node.js 服务环境，不能由 GitHub Pages 运行。
- 后端负责访问财联社接口、MySQL 和豆包 API；API Key 不得写入前端。
- 前端通过 `/api` 和 SSE 连接后端。生产环境需要将前端站点的 `/api` 反向代理到后端，或把 `client/nuxt.config.ts` 的后端地址改成你的服务域名。

## 启动后端

```bash
cd server
cp .env.example .env
# 填写 DATABASE_URL、JWT_SECRET、ARK_API_KEY、ARK_MODEL
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

## 启动前端

```bash
cd client
npm install
npm run dev
```

当前看板的静态 AI 投研页仍然保留，作为没有后端时的公开数据预览；要获得与原项目一致的实时电报和大模型分析，应使用本目录的前后端并配置真实后端地址。

原项目来源：<https://github.com/XiaoRongwen/stock_ai_getmoney>
