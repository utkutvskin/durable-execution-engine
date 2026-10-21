FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --prod \
  && find . -path '*/node_modules' -prune -o -name '*.test.ts' -type f -exec rm -f {} + \
  && rm -rf test docs .github

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "packages/cli/bin/wf.js"]
CMD ["dev", "--host", "0.0.0.0", "--port", "8080"]
