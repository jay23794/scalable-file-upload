import {
  AfterViewChecked,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TextFieldModule } from '@angular/cdk/text-field';
import { Subscription } from 'rxjs';
import { QueryProcessService } from './query-process.service';
import {
  QueryModel,
  QueryRecord,
  SourceRef,
  StreamEvent,
  UploadSummary,
} from './query-process.types';

interface ChatMessage {
  id: string;
  author: 'me' | 'bot';
  text: string;
  timestamp: Date;
  /** A bot bubble still receiving tokens. Drives the caret and the send lock. */
  streaming?: boolean;
  sources?: SourceRef[];
  failed?: boolean;
  /** Latest progress step, shown while the bubble is still empty. */
  step?: string;
}

interface ModelOption {
  value: QueryModel;
  label: string;
  /** Only Gemini is wired in the ml worker; the others would silently run Gemini. */
  disabled: boolean;
  hint?: string;
}

const MODEL_OPTIONS: ModelOption[] = [
  { value: 'gemini', label: 'Gemini', disabled: false },
  { value: 'gpt-4o', label: 'GPT-4o', disabled: true, hint: 'Not wired in the ML worker yet' },
  { value: 'claude', label: 'Claude', disabled: true, hint: 'Not wired in the ML worker yet' },
];

@Component({
  selector: 'app-query-process',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatTooltipModule,
    TextFieldModule,
  ],
  templateUrl: './query-process.html',
  styleUrl: './query-process.scss',
})
export class QueryProcess implements OnInit, OnDestroy, AfterViewChecked {
  private readonly scrollContainer = viewChild<ElementRef<HTMLDivElement>>('scrollContainer');
  private readonly api = inject(QueryProcessService);

  // Every open SSE subscription, so ngOnDestroy can close all of them. A leaked
  // EventSource keeps a server-side blocking Redis reader alive.
  private readonly streams = new Set<Subscription>();

  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly uploads = signal<UploadSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);

  protected readonly modelOptions = MODEL_OPTIONS;
  // Signals, not plain fields: canSend/modelLabel are computed from these, and a
  // computed over a plain field would cache its first value and never update.
  protected readonly model = signal<QueryModel>('gemini');
  protected readonly connectors = signal<string[]>([]);
  protected draft = '';

  protected readonly readyUploads = computed(() =>
    this.uploads().filter((u) => u.status === 'ready'),
  );

  protected readonly generating = computed(() =>
    this.messages().some((m) => m.streaming),
  );

  protected readonly modelLabel = computed(
    () => MODEL_OPTIONS.find((o) => o.value === this.model())?.label ?? this.model(),
  );

  protected readonly canSend = computed(
    () => !this.generating() && this.connectors().length > 0,
  );

  ngOnInit(): void {
    this.loadUploads();
    this.loadHistory();
  }

  ngOnDestroy(): void {
    // Closing these does NOT cancel generation — the worker runs to completion
    // and Path A persists the answer. It only stops us watching.
    for (const sub of this.streams) sub.unsubscribe();
    this.streams.clear();
  }

  ngAfterViewChecked(): void {
    const el = this.scrollContainer()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  private loadUploads(): void {
    this.api.listUploads().subscribe({
      next: (res) => {
        const ready = (res.data ?? []).filter((u) => u.status === 'ready');
        this.uploads.set(res.data ?? []);
        // Default to a NARROW selection, not select-all. Retrieval precision
        // degrades sharply as the candidate pool grows, and scoping is the main
        // quality lever the user has — so start at the newest document only.
        this.connectors.set(ready.length > 0 ? [ready[0].id] : []);
      },
      error: () => this.uploads.set([]),
    });
  }

  private loadHistory(): void {
    this.api.list().subscribe({
      next: (res) => {
        // The API returns newest-first; a transcript reads oldest-first.
        const records = [...(res.data ?? [])].reverse();
        this.messages.set(records.flatMap((r) => this.toMessages(r)));
        this.loading.set(false);

        // Anything still generating was left mid-flight by an earlier visit —
        // reattach so it finishes rendering live instead of sitting frozen.
        for (const record of records) {
          if (record.status === 'generating') this.attach(record.id);
        }
      },
      error: (err) => {
        this.loading.set(false);
        this.loadError.set(err?.message ?? 'Could not load your query history');
      },
    });
  }

  private toMessages(record: QueryRecord): ChatMessage[] {
    const asked: ChatMessage = {
      id: `${record.id}:q`,
      author: 'me',
      text: record.query,
      timestamp: new Date(record.createdAt),
    };

    const answered: ChatMessage = {
      id: record.id,
      author: 'bot',
      text: record.text ?? '',
      timestamp: new Date(record.updatedAt),
      streaming: record.status === 'generating',
      sources: record.sources,
      failed: record.status === 'failed',
    };

    if (record.status === 'failed') {
      answered.text = record.failedReason ?? 'Generation failed';
    }

    return [asked, answered];
  }

  /** Chip label: the filename while one document is picked, a count beyond that. */
  protected readonly connectorLabel = computed(() => {
    const picked = this.connectors();
    if (picked.length === 0) return 'Documents';
    if (picked.length === 1) return this.uploadName(picked[0]);
    return `${picked.length} documents`;
  });

  protected isConnectorSelected(uploadId: string): boolean {
    return this.connectors().includes(uploadId);
  }

  protected toggleConnector(uploadId: string): void {
    this.connectors.update((picked) =>
      picked.includes(uploadId)
        ? picked.filter((id) => id !== uploadId)
        : [...picked, uploadId],
    );
  }

  /** Enter sends; Shift+Enter keeps its normal newline in the textarea. */
  protected onEnter(event: Event): void {
    const key = event as KeyboardEvent;
    if (key.shiftKey) return;

    event.preventDefault();
    this.send();
  }

  protected send(): void {
    const query = this.draft.trim();
    if (!query || !this.canSend()) return;

    this.draft = '';

    this.api.submit({ query, model: this.model(), connectors: this.connectors() }).subscribe({
      next: (res) => {
        const queryId = res.data.queryId;
        const now = new Date();

        this.messages.update((list) => [
          ...list,
          { id: `${queryId}:q`, author: 'me', text: query, timestamp: now },
          { id: queryId, author: 'bot', text: '', timestamp: now, streaming: true },
        ]);

        this.attach(queryId);
      },
      error: (err) => {
        const now = new Date();
        this.messages.update((list) => [
          ...list,
          { id: `local-${now.getTime()}:q`, author: 'me', text: query, timestamp: now },
          {
            id: `local-${now.getTime()}`,
            author: 'bot',
            text: err?.error?.error ?? 'Could not submit the query',
            timestamp: now,
            failed: true,
          },
        ]);
      },
    });
  }

  /** Opens the SSE view onto one generation and folds its events into the bubble. */
  private attach(queryId: string): void {
    const sub = this.api.stream(queryId).subscribe({
      next: (event) => this.apply(queryId, event),
      error: (err) => {
        this.patch(queryId, (m) => ({
          ...m,
          streaming: false,
          failed: true,
          text: m.text || (err?.message ?? 'Connection lost'),
        }));
        this.streams.delete(sub);
      },
      complete: () => this.streams.delete(sub),
    });

    this.streams.add(sub);
  }

  private apply(queryId: string, event: StreamEvent): void {
    switch (event.type) {
      case 'progress':
        this.patch(queryId, (m) => ({ ...m, step: event.step }));
        break;

      case 'token':
        this.patch(queryId, (m) => ({ ...m, text: m.text + event.text, step: undefined }));
        break;

      case 'restart':
        // A retry is replaying the answer from the beginning. Drop what we have
        // or the two attempts concatenate into nonsense.
        this.patch(queryId, (m) => ({ ...m, text: '', sources: undefined }));
        break;

      case 'done':
        this.patch(queryId, (m) => ({
          ...m,
          streaming: false,
          step: undefined,
          sources: event.sources,
          timestamp: new Date(),
        }));
        break;

      case 'cancelled':
        this.patch(queryId, (m) => ({ ...m, streaming: false, step: undefined }));
        break;

      case 'error':
        this.patch(queryId, (m) => ({
          ...m,
          streaming: false,
          step: undefined,
          failed: true,
          text: m.text || event.message,
        }));
        break;
    }
  }

  private patch(id: string, change: (m: ChatMessage) => ChatMessage): void {
    this.messages.update((list) => list.map((m) => (m.id === id ? change(m) : m)));
  }

  protected uploadName(uploadId: string): string {
    return this.uploads().find((u) => u.id === uploadId)?.filename ?? uploadId;
  }
}
