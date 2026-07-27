import type { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

let ioInstance: SocketIOServer | undefined;

export function initIo(httpServer: HttpServer): SocketIOServer {
  if (ioInstance) return ioInstance;

  ioInstance = new SocketIOServer(httpServer, {
    cors: { origin: '*' },
  });

  return ioInstance;
}

export function getIo(): SocketIOServer {
  if (!ioInstance) {
    throw new Error('Socket.io not initialized. Call initIo(httpServer) first.');
  }
  return ioInstance;
}
