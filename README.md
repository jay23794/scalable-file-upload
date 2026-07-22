# scalable-file-upload

Monorepo containing an Angular frontend and a Node/Express backend.

## Structure

```
.
├── frontend/            # Angular app
├── backend/             # Node/Express API
├── docker-compose.yml
├── .gitignore
└── README.md
```

## Development

Frontend:
```
cd frontend
npm install
npm start
```

Backend:
```
cd backend
npm install
npm run dev
```

## Docker

```
docker compose up --build
```

Frontend → http://localhost:4200
Backend  → http://localhost:3000
