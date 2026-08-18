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
#
# bash is now mandatory rather than merely expected: the agent's shell and the acceptance
# gate's are the same binary by construction (src/workspace/toolchain.ts), and a runner
# that cannot find one refuses to start a session instead of quietly falling back to sh.
RUN apk add --no-cache git openssh-client ca-certificates bash coreutils tini

# nix, for building a task's dev environment (DESIGN.md §8.1).
#
# Language toolchains a specific repo needs — lua, go, a compiler — still do not live in
# this image, but the reason has changed. It used to be "that is what capability-matched
# runners are for", which was a promise the design could not keep: a capability is a fact
# about a machine that cannot be provisioned, so `requires: [lua]` was never expressible
# and such a task would have waited for a runner that could never advertise it. Toolchains
# are BUILT per task now, and this is what builds them.
#
# COPYed from the official image rather than `apk add nix`, because a nix store path is a
# self-contained closure: the binaries carry their own libc and do not care that this base
# is musl. That property is the whole reason this works on alpine, and it is the same one
# that makes cache.nixos.org usable here.
#
# Pinned, like everything else. nix is what guarantees a reproducible environment;
# installing whatever is current would put the one unpinned dependency underneath all the
# pinned ones.
COPY --from=nixos/nix:2.31.2 /nix /nix

ENV PATH="/nix/var/nix/profiles/default/bin:${PATH}" \
    NIX_CONFIG="experimental-features = nix-command flakes"

# Fails the BUILD rather than the pod. Without it a broken copy ships, every task that
# declares a toolchain parks, and the first sign of it is a Discord message hours later.
RUN nix --version && nix-collect-garbage --version

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
#
# /nix is left exactly where nix expects it. Relocating the store with NIX_STORE_DIR
# invalidates every binary-cache substitution — store paths are addressed by their literal
# /nix/store prefix — so the store is durable only where something durable is MOUNTED at
# /nix, and this image is deliberately indifferent to whether anything is.
#
# Unmounted (a machine runner, a local `docker run`) the store is the container's writable
# layer and a restart discards whatever was substituted. That is a slower first session, not
# a broken one: the resolver's cache checks that the paths it remembers still exist and
# re-resolves when they do not, so it can never hand the agent a PATH of directories that
# are gone.
#
# In the cluster a PVC is mounted at /nix and seeded from this closure by an initContainer,
# because keel rolls the Deployment on every push to `main` and re-substituting a dotnet SDK
# each time is a gigabyte of download for nothing. That is entirely a deployment-repo
# concern — nothing here changes for it, which is why the seed copies /nix rather than
# moving it.
RUN mkdir -p /work /run/caterpillar && chown -R node:node /work /run/caterpillar \
 && chown -R node:node /nix

USER node
ENV NODE_ENV=production
EXPOSE 9090

# tini reaps the processes the agent's bash tool spawns; without it a long-running
# supervisor accumulates zombies from every session.
#
# The aggregating viewer (DESIGN.md §18) is the SAME image with a different command:
#   command: ["node", "/app/dist/cli/view.js"]
# `dist/` is copied whole, so it costs a Deployment manifest and no second build. That
# process holds no credential, no volume and no ServiceAccount token — it reads the
# runners' `/api/*` routes and nothing else.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/dist/index.js"]
