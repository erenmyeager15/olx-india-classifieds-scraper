FROM apify/actor-node:20

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --include=dev

COPY . ./
RUN npm run build
RUN npm prune --omit=dev

CMD ["npm", "start"]
