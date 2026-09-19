import { Pipe, PipeTransform } from '@angular/core';
import { marked } from 'marked';

/**
 * Renders assistant answers, which arrive as markdown.
 *
 * Bound with [innerHTML], never bypassSecurityTrustHtml: Angular's sanitizer
 * strips scripts and event handlers from the result, and the model's output is
 * untrusted input like any other. Losing that guard is the whole risk here.
 *
 * Pure, so it re-parses only when the text actually changes. During streaming
 * that is once per token, which is inherent to rendering a partial document —
 * marked is fast enough at answer-sized inputs for that to be invisible.
 */
@Pipe({ name: 'markdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  transform(value: string | undefined): string {
    if (!value) return '';

    return marked.parse(value, {
      async: false,
      gfm: true,
      // Treat a single newline as a line break. Chat answers are written like
      // messages, not like prose files, so the markdown default of folding
      // them into one paragraph reads as broken.
      breaks: true,
    });
  }
}
