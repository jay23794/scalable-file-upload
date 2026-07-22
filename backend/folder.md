backend/
│
├── src/
│   ├── app.ts
│   ├── server.ts
│   │
│   ├── config/
│   │   ├── database.ts
│   │   ├── redis.ts
│   │   ├── socket.ts
│   │   ├── env.ts
│   │   └── logger.ts
│   │
│   ├── common/
│   │   ├── middleware/
│   │   ├── utils/
│   │   ├── constants/
│   │   ├── errors/
│   │   ├── validators/
│   │   └── types/
│   │
│   ├── features/
│   │   │
│   │   ├── auth/
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── auth.routes.ts
│   │   │   ├── auth.model.ts
│   │   │   └── auth.validation.ts
│   │   │
│   │   ├── upload/
│   │   │   ├── upload.controller.ts
│   │   │   ├── upload.service.ts
│   │   │   ├── upload.routes.ts
│   │   │   ├── upload.model.ts
│   │   │   ├── upload.validation.ts
│   │   │   └── upload.socket.ts
│   │   │
│   │   ├── processing/
│   │   │   ├── processing.controller.ts
│   │   │   ├── processing.service.ts
│   │   │   ├── processing.routes.ts
│   │   │   ├── processing.worker.ts
│   │   │   ├── processing.queue.ts
│   │   │   └── processing.events.ts
│   │   │
│   │   ├── documents/
│   │   │   ├── document.controller.ts
│   │   │   ├── document.service.ts
│   │   │   ├── document.routes.ts
│   │   │   └── document.model.ts
│   │   │
│   │   └── search/
│   │       ├── search.controller.ts
│   │       ├── search.service.ts
│   │       ├── search.routes.ts
│   │       └── vector.service.ts
│   │
│   ├── queues/
│   │   ├── bull.ts
│   │   └── queue.constants.ts
│   │
│   ├── sockets/
│   │   ├── socket.server.ts
│   │   └── socket.events.ts
│   │
│   └── jobs/
│       └── document.worker.ts
│
├── uploads/
├── docker-compose.yml
├── package.json
└── tsconfig.json