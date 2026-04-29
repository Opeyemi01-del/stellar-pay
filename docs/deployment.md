# StellarPay Deployment & Configuration Guide

## Table of Contents

- [Environment Variables](#environment-variables)
- [Configuration Files](#configuration-files)
- [Docker Setup](#docker-setup)
- [Kubernetes Manifests](#kubernetes-manifests)
- [Production Deployment](#production-deployment)
- [Development vs Production](#development-vs-production)

---

## Environment Variables

### API Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | Yes | `3000` | Server port |
| `NODE_ENV` | No | `development` | Environment (`development`, `production`) |
| `LOG_LEVEL` | No | `info` | Logging level (`debug`, `info`, `warn`, `error`) |

### Database

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `DATABASE_POOL_SIZE` | No | `10` | Connection pool size |
| `DATABASE_SSL` | No | `false` | Enable SSL connection |

### Redis

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_URL` | Yes | - | Redis connection string |
| `REDIS_TTL` | No | `3600` | Cache TTL in seconds |

### JWT Authentication

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | - | Secret key for signing JWTs |
| `JWT_EXPIRATION` | No | `3600` | Token expiration in seconds |

### Stellar Network

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STELLAR_NETWORK` | Yes | `TESTNET` | Network (`TESTNET`, `PUBLIC`) |
| `STELLAR_HORIZON_URL` | Yes | `https://horizon-testnet.stellar.org` | Horizon RPC URL |
| `STELLAR_NETWORK_PASSPRASE` | No | - | Network passphrase |

### Treasury

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TREASURY_WALLET_ADDRESS` | Yes | - | Treasury wallet Stellar address |
| `SUPPORTED_ASSETS` | Yes | `USDC,ARS` | Comma-separated list of supported assets |

### Webhooks

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WEBHOOK_SECRET` | No | - | Secret for webhook signature verification |

### Rate Limiting

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RATE_LIMIT_TTL` | No | `60` | Rate limit window in seconds |
| `RATE_LIMIT_MAX` | No | `1000` | Maximum requests per window |

---

## Configuration Files

### Development (.env)

```bash
# Server
PORT=3000
NODE_ENV=development

# JWT
JWT_SECRET=dev-secret-key-do-not-use-in-production

# Stellar
STELLAR_NETWORK=TESTNET
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

# Treasury
TREASURY_WALLET_ADDRESS=GDTREASURYADDRESSXXXXXX
SUPPORTED_ASSETS=USDC,ARS

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/stellar_pay

# Redis
REDIS_URL=redis://localhost:6379

# Logging
LOG_LEVEL=debug
```

### Production (.env.production)

```bash
# Server
PORT=3000
NODE_ENV=production

# JWT - Use a strong, randomly generated secret
JWT_SECRET=<your-secure-random-secret-min-32-chars>

# Stellar
STELLAR_NETWORK=PUBLIC
STELLAR_HORIZON_URL=https://horizon.stellar.org

# Treasury
TREASURY_WALLET_ADDRESS=<your-production-treasury-address>
SUPPORTED_ASSETS=USDC,ARS

# Database
DATABASE_URL=postgresql://user:password@prod-db:5432/stellar_pay
DATABASE_SSL=true

# Redis
REDIS_URL=redis://prod-redis:6379

# Webhooks
WEBHOOK_SECRET=<your-webhook-secret>

# Rate Limiting
RATE_LIMIT_TTL=60
RATE_LIMIT_MAX=100

# Logging
LOG_LEVEL=warn
```

### Secure Secret Generation

```bash
# Generate secure JWT secret
openssl rand -base64 32

# Generate webhook secret
openssl rand -hex 32
```

---

## Docker Setup

### Dockerfile

Located at: `apps/api/Dockerfile`

```dockerfile
# Stage 1: Base setup
FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm
RUN apk add --no-cache curl

# Stage 2: Builder
FROM base AS builder
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter api build
RUN pnpm --filter api --prod deploy --legacy /pruned

# Stage 3: Production Runner
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Security: Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

COPY --from=builder --chown=appuser:nodejs /pruned .
USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

EXPOSE ${PORT}
CMD ["node", "dist/main.js"]
```

### Docker Compose

Create `docker-compose.yml` for local development:

```yaml
version: '3.8'

services:
  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
      - DATABASE_URL=postgresql://postgres:password@db:5432/stellar_pay
      - REDIS_URL=redis://redis:6379
    depends_on:
      - db
      - redis
    volumes:
      - ./apps/api:/app/apps/api
    command: pnpm run start:dev

  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
      POSTGRES_DB: stellar_pay
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data

volumes:
  pgdata:
  redisdata:
```

### Build and Run

```bash
# Build Docker image
docker build -t stellarpay/api -f apps/api/Dockerfile .

# Run container
docker run -p 3000:3000 --env-file .env stellarpay/api

# Run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f api
```

---

## Kubernetes Manifests

### Deployment

Create `k8s/deployment.yml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: stellarpay-api
  labels:
    app: stellarpay-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: stellarpay-api
  template:
    metadata:
      labels:
        app: stellarpay-api
    spec:
      containers:
      - name: api
        image: stellarpay/api:latest
        ports:
        - containerPort: 3000
        env:
        - name: NODE_ENV
          value: "production"
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: stellarpay-secrets
              key: jwt-secret
        - name: DATABASE_URL
          valueFrom:
            configMapKeyRef:
              name: stellarpay-config
              key: database-url
        - name: REDIS_URL
          valueFrom:
            configMapKeyRef:
              name: stellarpay-config
              key: redis-url
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
```

### Service

Create `k8s/service.yml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: stellarpay-api
spec:
  type: ClusterIP
  selector:
    app: stellarpay-api
  ports:
  - port: 80
    targetPort: 3000
```

### Ingress

Create `k8s/ingress.yml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: stellarpay-api
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
  - hosts:
    - api.stellarpay.io
    secretName: stellarpay-tls
  rules:
  - host: api.stellarpay.io
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: stellarpay-api
            port:
              number: 80
```

### ConfigMap

Create `k8s/configmap.yml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: stellarpay-config
data:
  database-url: "postgresql://postgres@prod-db:5432/stellar_pay"
  redis-url: "redis://prod-redis:6379"
  stellar-network: "PUBLIC"
  stellar-horizon-url: "https://horizon.stellar.org"
```

### Secrets

Create `k8s/secrets.yml`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: stellarpay-secrets
type: Opaque
stringData:
  jwt-secret: "your-jwt-secret"
  webhook-secret: "your-webhook-secret"
```

---

## Production Deployment

### Prerequisites

1. **Infrastructure:**
   - PostgreSQL 15+ database
   - Redis 7+ instance
   - Kubernetes cluster (EKS/GKE/AKS)

2. **DNS:**
   - Configure `api.stellarpay.io` pointing to your load balancer

3. **SSL:**
   - Configure TLS certificate (Let's Encrypt or purchased)

### Step 1: Build Image

```bash
# Build production image
docker build -t stellarpay/api:latest -f apps/api/Dockerfile .

# Tag for registry
docker tag stellarpay/api:latest registry.stellarpay.io/api:latest

# Push to registry
docker push registry.stellarpay.io/api:latest
```

### Step 2: Configure Secrets

```bash
# Create Kubernetes secrets
kubectl create secret generic stellarpay-secrets \
  --from-literal=jwt-secret="$(openssl rand -base64 32)" \
  --from-literal=webhook-secret="$(openssl rand -hex 32)"
```

### Step 3: Apply Kubernetes Manifests

```bash
# Apply ConfigMap
kubectl apply -f k8s/configmap.yml

# Apply Secrets
kubectl apply -f k8s/secrets.yml

# Apply Deployment
kubectl apply -f k8s/deployment.yml

# Apply Service
kubectl apply -f k8s/service.yml

# Apply Ingress
kubectl apply -f k8s/ingress.yml
```

### Step 4: Verify Deployment

```bash
# Check pods
kubectl get pods -l app=stellarpay-api

# Check service
kubectl get svc stellarpay-api

# Check health
curl https://api.stellarpay.io/health

# View logs
kubectl logs -l app=stellarpay-api -f
```

### Step 5: Scale and Monitor

```bash
# Scale deployment
kubectl scale deployment stellarpay-api --replicas=5

# Enable autoscaling
kubectl autoscale deployment stellarpay-api \
  --cpu-percent=70 --min=3 --max=10

# View pod metrics
kubectl top pods
```

---

## Development vs Production

### Comparison

| Setting | Development | Production |
|---------|-------------|------------|
| `NODE_ENV` | `development` | `production` |
| `LOG_LEVEL` | `debug` | `warn` |
| `DATABASE_SSL` | `false` | `true` |
| `RATE_LIMIT_MAX` | `10000` | `100` |
| `JWT_EXPIRATION` | `86400` | `3600` |
| `CORS` | `*` | Specific domains |
| `Debugging` | Enabled | Disabled |

### Environment-Specific Config

```typescript
// config/config.service.ts
@Injectable()
export class ConfigService {
  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get databaseConfig() {
    return {
      url: this.get('DATABASE_URL'),
      ssl: this.isProduction ? this.get boolean('DATABASE_SSL') : false,
      poolSize: this.isProduction ? 20 : 10,
    };
  }

  get rateLimitConfig() {
    return {
      ttl: this.get number('RATE_LIMIT_TTL'),
      limit: this.isProduction ? 100 : 10000,
    };
  }
}
```

---

## Health Checks

### Endpoint: GET /health

Returns health status of all dependencies:

```json
{
  "status": "ok",
  "info": {
    "database": { "status": "up" },
    "redis": { "status": "up" },
    "blockchain_rpc": { "status": "up" },
    "treasury_wallet": { "status": "up" }
  }
}
```

### Docker Health Check

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
```

### Kubernetes Liveness Probe

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 10
```

---

## Monitoring

### Recommended Metrics

- Request latency (p50, p95, p99)
- Error rate
- Memory usage
- CPU usage
- Database connection pool
- Redis memory
- JWT token validation failures

### Logging

```bash
# Export logs from Kubernetes
kubectl logs -l app=stellarpay-api --tail=1000 > stellarpay.log
```

---

## License

MIT