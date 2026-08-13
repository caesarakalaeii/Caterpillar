# Caterpillar supervisor image. See DESIGN.md §10.
#
# The agent's bash tool runs INSIDE this container, so the image is also the agent's
# toolbox: git is mandatory (worktrees, mirrors, pushes), and the rest is what a coding
# agent needs to be useful on this codebase. Anything absent here is a capability the
# agent silently does not have.
FROM node:22-alpine AS build

WORKDIR /app

# --ignore-scripts matches .npmrc: no dependency lifecycle scripts run, here or in CI.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production dependency tree only. Separate from the build tree so typescript and the
# type packages do not ship.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine

# git: the entire state model. openssh-client: git's ssh transport for repos that use
# it. ca-certificates: TLS to the forges. bash/coreutils: the agent's shell expects a
# real one, and busybox's differs enough to break heredocs and process substitution.
RUN apk add --no-cache git openssh-client ca-certificates bash coreutils tini

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# git invokes the credential helper by path; it must be executable and on a stable
# path the worktree config can point at (DESIGN.md §9.2).
RUN printf '#!/bin/sh\nexec node /app/dist/cli/credential-helper.js "$@"\n' \
      > /usr/local/bin/caterpillar-cred \
 && chmod 0755 /usr/local/bin/caterpillar-cred

# The PVC mounts here; ownership is set by the Deployment's fsGroup.
RUN mkdir -p /work /run/caterpillar && chown -R node:node /work /run/caterpillar

USER node
ENV NODE_ENV=production
EXPOSE 9090

# tini reaps the processes the agent's bash tool spawns; without it a long-running
# supervisor accumulates zombies from every session.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/dist/index.js"]
