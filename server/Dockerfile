# The API and its Socket.IO server.
#
# There was no deployment configuration of any kind checked in, so how this runs
# in production lived only in whatever dashboard someone configured once. This is
# not a claim about where it is deployed — it is a reproducible way to run it
# anywhere that takes a container, and a written answer to "what does this need".

FROM node:22-slim AS deps

# `bcrypt` is a native module. On slim images its prebuilt binary usually
# resolves, but when it does not, node-gyp needs a toolchain — and the failure
# ("invalid ELF header", or a gyp error mid-install) is otherwise mystifying.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copied before the source so a change to application code does not invalidate
# the dependency layer — this is the slow step.
COPY package.json package-lock.json ./

# `npm ci` honours the lockfile exactly; `--omit=dev` drops nodemon and
# concurrently, which have no business in a production image.
RUN npm ci --omit=dev

FROM node:22-slim AS runtime

ENV NODE_ENV=production

# Node's own image ships an unprivileged `node` user. Running as root inside a
# container is the default and is worth undoing: a process that only needs to
# read its own code and talk to Mongo does not need to own the filesystem.
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

# Multer writes uploads here before they go to Cloudinary, and deletes them
# afterwards. It must exist and be writable by the runtime user; the code creates
# it if missing, but only if the parent directory allows it.
RUN mkdir -p uploads && chown -R node:node uploads

USER node

# Matches the default in server.js. The platform overrides it by setting PORT.
EXPOSE 5000

# `node server.js` directly, with no npm wrapper: npm does not forward SIGTERM to
# its child, so a container stop would wait out the full grace period and then be
# killed, dropping in-flight requests and open sockets instead of closing them.
CMD ["node", "server.js"]
