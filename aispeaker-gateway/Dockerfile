ARG BUILD_FROM
FROM ${BUILD_FROM}

# 安装 Node.js
RUN apk add --no-cache nodejs npm

# 复制应用代码
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production --no-optional && npm cache clean --force

COPY src/ ./src/

# 复制启动脚本
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
