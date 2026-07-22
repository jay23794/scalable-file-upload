import { Component, ElementRef, signal, viewChild, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

interface ChatMessage {
  id: number;
  author: 'me' | 'bot';
  text: string;
  timestamp: Date;
}

@Component({
  selector: 'app-query-process',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule
  ],
  templateUrl: './query-process.html',
  styleUrl: './query-process.scss'
})
export class QueryProcess implements AfterViewChecked {
  private readonly scrollContainer = viewChild<ElementRef<HTMLDivElement>>('scrollContainer');
  private nextId = 1;

  protected readonly messages = signal<ChatMessage[]>([
    { id: 0, author: 'bot', text: 'Hi! Ask me anything about your uploaded files.', timestamp: new Date() }
  ]);
  protected draft = '';

  send() {
    const text = this.draft.trim();
    if (!text) return;

    this.messages.update(list => [
      ...list,
      { id: this.nextId++, author: 'me', text, timestamp: new Date() }
    ]);
    this.draft = '';

    setTimeout(() => {
      this.messages.update(list => [
        ...list,
        {
          id: this.nextId++,
          author: 'bot',
          text: `Processing your query: "${text}"`,
          timestamp: new Date()
        }
      ]);
    }, 600);
  }

  ngAfterViewChecked() {
    const el = this.scrollContainer()?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }
}
