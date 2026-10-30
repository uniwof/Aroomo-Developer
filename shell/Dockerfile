# Aroomo Shell 镜像（薄界面层，不含任何 LobeHub 代码；同时支持 linux/amd64 与 linux/arm64，PRODUCT §7.1）
FROM node:22.23.4-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22.23.4-alpine3.24
ENV NODE_ENV=production
WORKDIR /app
# 零运行时依赖：只要编译结果和静态资源
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SHELL_PORT||3000)+'/aroomo/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
