FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Cognito settings baked into the bundle (compose passes them from .env; empty = auth disabled).
ARG VITE_COGNITO_REGION VITE_COGNITO_USER_POOL_ID VITE_COGNITO_CLIENT_ID VITE_COGNITO_DOMAIN
ENV VITE_COGNITO_REGION=$VITE_COGNITO_REGION VITE_COGNITO_USER_POOL_ID=$VITE_COGNITO_USER_POOL_ID \
    VITE_COGNITO_CLIENT_ID=$VITE_COGNITO_CLIENT_ID VITE_COGNITO_DOMAIN=$VITE_COGNITO_DOMAIN
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
