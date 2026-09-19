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
import { Observable, Subscription, map, of, switchMap, tap } from 'rxjs';
import { MarkdownPipe } from './markdown.pipe';
import { QueryProcessService } from './query-process.service';
import {
  ConversationRecord,
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

/** The first question becomes the conversation title; the schema caps it at 200. */
const TITLE_MAX = 80;

/** What the assistant is called in the transcript. */
const ASSISTANT_NAME = 'Nova';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface ConversationGroup {
  label: string;
  items: ConversationRecord[];
}

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
    MarkdownPipe,
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

  protected readonly conversations = signal<ConversationRecord[]>([]);
  // null means "a new chat that has not been sent yet" — no row exists for it
  // server-side, and send() is what mints one.
  protected readonly activeId = signal<string | null>(null);
  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly uploads = signal<UploadSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);

  protected readonly assistantName = ASSISTANT_NAME;
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

  /**
   * Buckets the sidebar by age. The list arrives sorted by updatedAt desc, so
   * each bucket keeps that order and the headings come out in sequence — no
   * re-sorting needed, only partitioning.
   */
  protected readonly conversationGroups = computed<ConversationGroup[]>(() => {
    const now = new Date();
    // Midnight, not now-minus-24h: "Yesterday" has to mean the calendar day,
    // otherwise a conversation from this morning drifts into it after lunch.
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const groups: ConversationGroup[] = [
      { label: 'Today', items: [] },
      { label: 'Yesterday', items: [] },
      { label: 'Previous 7 days', items: [] },
      { label: 'Older', items: [] },
    ];

    for (const conversation of this.conversations()) {
      const at = new Date(conversation.updatedAt).getTime();
      if (at >= today) groups[0].items.push(conversation);
      else if (at >= today - DAY) groups[1].items.push(conversation);
      else if (at >= today - 7 * DAY) groups[2].items.push(conversation);
      else groups[3].items.push(conversation);
    }

    return groups.filter((group) => group.items.length > 0);
  });

  ngOnInit(): void {
    this.loadUploads();
    this.bootstrap();
  }

  ngOnDestroy(): void {
    this.closeStreams();
  }

  /**
   * Closing these does NOT cancel generation — the worker runs to completion
   * and Path A persists the answer. It only stops us watching, which is also
   * why switching conversations mid-generation is safe: the answer is still
   * there on the way back.
   */
  private closeStreams(): void {
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

  /** First paint: the sidebar, plus whichever conversation they were last in. */
  private bootstrap(): void {
    this.api.listConversations().subscribe({
      next: (res) => {
        const list = res.data ?? [];
        this.conversations.set(list);

        // Sorted by updatedAt desc server-side, so [0] is the most recent one.
        // An empty list is not an error — it is a first visit, and the blank
        // composer is the right thing to show.
        if (list.length > 0) this.open(list[0].id);
        else this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.loadError.set(err?.message ?? 'Could not load your conversations');
      },
    });
  }

  /** Re-reads the sidebar after a send, which reorders it by updatedAt. */
  private refreshConversations(): void {
    this.api.listConversations().subscribe({
      next: (res) => this.conversations.set(res.data ?? []),
      // A stale sidebar is not worth an error banner over a live transcript.
      error: () => {},
    });
  }

  protected open(id: string): void {
    if (id === this.activeId()) return;

    this.closeStreams();
    this.activeId.set(id);
    this.messages.set([]);
    this.loadError.set(null);
    this.loading.set(true);

    this.api.getConversation(id).subscribe({
      next: (res) => {
        // A slower earlier request must not overwrite a newer selection.
        if (this.activeId() !== id) return;

        // Already oldest-first from the backend, which is transcript order.
        const queries = res.data?.queries ?? [];
        this.messages.set(queries.flatMap((r) => this.toMessages(r)));
        this.loading.set(false);

        // Anything still generating was left mid-flight by an earlier visit —
        // reattach so it finishes rendering live instead of sitting frozen.
        for (const record of queries) {
          if (record.status === 'generating') this.attach(record.id);
        }
      },
      error: (err) => {
        if (this.activeId() !== id) return;
        this.loading.set(false);
        this.loadError.set(err?.message ?? 'Could not load this conversation');
      },
    });
  }

  /**
   * Clears to a blank chat without touching the server. The row is minted by
   * the first send, so repeatedly clicking this cannot litter the sidebar with
   * empty conversations.
   */
  protected newChat(): void {
    this.closeStreams();
    this.activeId.set(null);
    this.messages.set([]);
    this.loadError.set(null);
    this.loading.set(false);
    this.draft = '';
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

    const open = this.activeId();

    // A conversation is minted on the first message rather than when "New chat"
    // is clicked, so an abandoned blank chat leaves nothing behind. The first
    // question doubles as the title — the backend would otherwise file it all
    // under 'New conversation' and the sidebar would be unreadable.
    const conversationId$: Observable<string> = open
      ? of(open)
      : this.api.startConversation({ title: query.slice(0, TITLE_MAX) }).pipe(
          map((res) => res.data.id),
          tap((id) => this.activeId.set(id)),
        );

    conversationId$
      .pipe(
        switchMap((conversationId) =>
          this.api.submit({
            conversationId,
            query,
            model: this.model(),
            connectors: this.connectors(),
          }),
        ),
      )
      .subscribe({
        next: (res) => {
          const queryId = res.data.queryId;
          const now = new Date();

          this.messages.update((list) => [
            ...list,
            { id: `${queryId}:q`, author: 'me', text: query, timestamp: now },
            { id: queryId, author: 'bot', text: '', timestamp: now, streaming: true },
          ]);

          this.attach(queryId);

          // Picks up a brand-new conversation, and reorders the sidebar for an
          // existing one whose updatedAt just moved.
          this.refreshConversations();
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

  /** Short age for a sidebar row — absolute date once it stops being useful. */
  protected relativeTime(iso: string): string {
    const at = new Date(iso).getTime();
    const elapsed = Date.now() - at;

    if (elapsed < MINUTE) return 'just now';
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
    if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
    if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;

    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  protected uploadName(uploadId: string): string {
    return this.uploads().find((u) => u.id === uploadId)?.filename ?? uploadId;
  }
}
