FROM node:24-slim
WORKDIR /app
COPY . .
ENV DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
