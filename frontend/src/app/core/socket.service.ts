import { Injectable, OnDestroy } from '@angular/core';
import { Observable } from 'rxjs';
import { io, Socket } from 'socket.io-client';

const SOCKET_URL = 'http://localhost:3000';

export type OcrSocketEvent =
  | { event: 'ocr:progress'; payload: { step: string; pct: number } }
  | { event: 'ocr:completed'; payload: unknown }
  | { event: 'ocr:failed'; payload: { reason: string } };

@Injectable({ providedIn: 'root' })
export class SocketService implements OnDestroy {
  private socket: Socket | undefined;

  private ensureSocket(): Socket {
    if (!this.socket) {
      this.socket = io(SOCKET_URL, { transports: ['websocket', 'polling'] });
    }
    return this.socket;
  }

  subscribe(uploadId: string): Observable<OcrSocketEvent> {
    return new Observable<OcrSocketEvent>((subscriber) => {
      const socket = this.ensureSocket();

      const emitSubscribe = () => socket.emit('subscribe', { uploadId });
      if (socket.connected) emitSubscribe();
      else socket.once('connect', emitSubscribe);

      const onProgress = (payload: { step: string; pct: number }) =>
        subscriber.next({ event: 'ocr:progress', payload });
      const onCompleted = (payload: unknown) =>
        subscriber.next({ event: 'ocr:completed', payload });
      const onFailed = (payload: { reason: string }) =>
        subscriber.next({ event: 'ocr:failed', payload });

      socket.on('ocr:progress', onProgress);
      socket.on('ocr:completed', onCompleted);
      socket.on('ocr:failed', onFailed);

      return () => {
        socket.off('ocr:progress', onProgress);
        socket.off('ocr:completed', onCompleted);
        socket.off('ocr:failed', onFailed);
      };
    });
  }

  ngOnDestroy(): void {
    this.socket?.disconnect();
    this.socket = undefined;
  }
}
