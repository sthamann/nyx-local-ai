import { marked, type TokenizerAndRendererExtension } from 'marked';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';

/** Renders TeX to HTML; KaTeX escapes everything, so the output is innerHTML-safe. */
function renderTex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false });
  } catch {
    const escaped = tex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return displayMode ? `<pre><code>${escaped}</code></pre>` : `<code>${escaped}</code>`;
  }
}

// Math support (#a — models emit LaTeX): $$…$$ / \[…\] as display blocks,
// \(…\) / $…$ inline. Tokenized before marked's own rules so underscores,
// asterisks and backslashes inside formulas survive markdown parsing.
const BLOCK_MATH_PATTERNS = [/^\$\$([\s\S]+?)\$\$(?:\s*\n+|\s*$)/, /^\\\[([\s\S]+?)\\\](?:\s*\n+|\s*$)/];

const blockMath: TokenizerAndRendererExtension = {
  name: 'blockMath',
  level: 'block',
  tokenizer(src: string) {
    for (const pattern of BLOCK_MATH_PATTERNS) {
      const match = pattern.exec(src);
      if (match) {
        return { type: 'blockMath', raw: match[0], text: match[1].trim() };
      }
    }
    return undefined;
  },
  renderer(token) {
    return `<div class="nyx-math-block">${renderTex(String(token.text), true)}</div>\n`;
  },
};

// Inline order matters: $$…$$ before $…$. The $…$ rule requires non-space
// content boundaries and no trailing digit, so "$5 and $10" stays plain text.
const INLINE_MATH_PATTERNS: Array<{ pattern: RegExp; display: boolean }> = [
  { pattern: /^\$\$([^\n$]+?)\$\$/, display: true },
  { pattern: /^\\\[([\s\S]+?)\\\]/, display: true },
  { pattern: /^\\\(([\s\S]+?)\\\)/, display: false },
  { pattern: /^\$(?=\S)((?:\\[^\n]|[^\\\n$])+?)(?<=\S)\$(?!\d)/, display: false },
];

const inlineMath: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start(src: string) {
    const index = src.search(/\$|\\\(|\\\[/);
    return index === -1 ? undefined : index;
  },
  tokenizer(src: string) {
    for (const { pattern, display } of INLINE_MATH_PATTERNS) {
      const match = pattern.exec(src);
      if (match) {
        return { type: 'inlineMath', raw: match[0], text: match[1].trim(), display };
      }
    }
    return undefined;
  },
  renderer(token) {
    return renderTex(String(token.text), token.display === true);
  },
};

marked.setOptions({ gfm: true, breaks: true });
marked.use({ extensions: [blockMath, inlineMath] });

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
