# LeaseBase maintenance-service

Maintenance work orders — request, assign, track, complete.

## Stack

- **Runtime**: Node.js / NestJS (planned)
- **Container**: Docker -> ECS Fargate
- **Registry**: ECR `leasebase-{env}-v2-maintenance-service`
- **Port**: 3000

## Infrastructure

Managed by Terraform in [leasebase-iac](https://github.com/motart/leasebase-iac).

## Getting Started

```bash
npm install
npm run start:dev
docker build -t leasebase-maintenance-service .
npm test
```
