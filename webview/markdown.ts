import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';

marked.setOptions({ gfm: true, breaks: true });

/** Renders markdown into an element (without syntax highlighting — cheap, for streaming). */
export function renderMarkdown(el: HTMLElement, text: string): void {
  el.innerHTML = marked.parse(text) as string;
}

/** Full render: markdown + syntax highlighting + copy buttons (for finished messages). */
export function renderMarkdownFinal(el: HTMLElement, text: string): void {
  renderMarkdown(el, text);
  highlightCode(el);
  addCopyButtons(el);
}

export function highlightCode(container: HTMLElement): void {
  container.querySelectorAll('pre code').forEach((block) => {
    if (block.classList.contains('hljs')) {
      return;
    }
    try {
      hljs.highlightElement(block as HTMLElement);
    } catch {
      // unknown language — leave as-is
    }
  });
}

export function addCopyButtons(container: HTMLElement): void {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.nyx-copy')) {
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'nyx-copy';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code');
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
      void navigator.clipboard?.writeText(code);
      btn.textContent = 'Copied';
      window.setTimeout(() => (btn.textContent = 'Copy'), 1200);
    });
    pre.appendChild(btn);
  });
}
