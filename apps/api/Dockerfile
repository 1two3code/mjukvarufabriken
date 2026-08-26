FROM --platform=linux/amd64 node:24-alpine3.22

WORKDIR /usr/src

# Copy workspace dependencies
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages ./packages/
COPY apps/api ./apps/api/

# Install dependencies
RUN npm i --omit=dev

# Start app
WORKDIR /usr/src/apps/api
ENV ADDRESS=0.0.0.0 PORT=80
CMD ["npm", "start"]
