# Synthetic Linux acceptance only; this image contains no app data or credentials.
FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /opt/worker
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY *.mjs ./
CMD ["node", "acceptance.mjs"]
