FROM --platform=linux/amd64 node:24-alpine3.22

WORKDIR /usr/src

# RDS global CA bundle (M9): lets @mf/db connect to *.rds.amazonaws.com with `verify-full`.
# NODE_EXTRA_CA_CERTS adds it to Node's default store, so public CAs keep working too.
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem

# Copy workspace dependencies
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages ./packages/
COPY apps/api ./apps/api/

# Install dependencies
RUN npm i --omit=dev --ignore-scripts

# Start app
WORKDIR /usr/src/apps/api
ENV ADDRESS=0.0.0.0 PORT=80
CMD ["npm", "start"]
