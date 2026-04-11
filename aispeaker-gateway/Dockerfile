FROM node:20-alpine

# 安装 bashio（Add-on 模式需要 run.sh 调用）
RUN apk add --no-cache bash curl jq

# 复制应用代码
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production --no-optional && npm cache clean --force

COPY src/ ./src/

# 复制启动脚本
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
