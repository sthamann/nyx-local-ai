import type { ToolSchema } from '../types';

/** Which tools are offered to the model. */
export type ToolProfile = 'full' | 'reduced' | 'auto';

export const toolSchemas: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a file in the workspace. Large files are shown partially — pass offset/limit (1-based line range) to page through them. Images and PDFs are converted to text automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          offset: { type: 'number', description: 'Optional 1-based start line.' },
          limit: { type: 'number', description: 'Optional number of lines to read from offset.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders inside a directory of the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: "Directory path. Use '.' for the root." } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search file contents in the workspace with a regular expression (fast, ripgrep-backed).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Regular expression or plain text to search for.' },
          glob: { type: 'string', description: "Optional file glob, e.g. '**/*.ts'." },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'semantic_search',
      description:
        'Search the codebase by MEANING (local embedding index): finds code related to a concept even when the words differ. Use for "where is X handled?"-style questions; use search_files for exact strings/regexes.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language description of what to find.' },
          limit: { type: 'number', description: 'Max results (default 8).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files by name or glob pattern (fuzzy filename search).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Filename substring or glob, e.g. 'Sidebar' or '**/*.css'." },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_outline',
      description:
        'Structural outline of a file (classes, functions, methods with line ranges) from the language server — much cheaper than reading a big file to find one function.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the workspace root.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_symbol',
      description: 'Find a class/function/method by name across the workspace (language-server symbol search). Returns definition locations.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Symbol name or prefix, e.g. "resolvePolicy".' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_references',
      description: 'Find all references to a symbol (language-server powered): who calls/uses it, across the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File that contains the symbol.' },
          symbol: { type: 'string', description: 'The exact symbol name as written in that file.' },
        },
        required: ['path', 'symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'format_file',
      description: "Format a file with the workspace's configured formatter (fix indentation/style after edits).",
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the workspace root.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description:
        'Send an HTTP request (GET/POST/PUT/PATCH/DELETE/HEAD) — for testing local dev servers and APIs. Returns status, headers, and body.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method.' },
          url: { type: 'string', description: 'http(s) URL, localhost allowed.' },
          headers: { type: 'object', description: 'Optional request headers.' },
          body: { type: 'string', description: 'Optional request body (e.g. JSON).' },
        },
        required: ['method', 'url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Pause for a few seconds (max 30) — e.g. to let a dev server boot before an http_request or browser_snapshot.',
      parameters: {
        type: 'object',
        properties: { seconds: { type: 'number', description: 'Seconds to wait (1–30).' } },
        required: ['seconds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with the given full content. Shows a diff for existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          content: { type: 'string', description: 'The complete new file content.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Make a targeted edit by replacing an exact string. old_string must be unique unless replace_all is true. Cheaper than rewriting the whole file. Whitespace-tolerant matching is applied when no exact match exists.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          old_string: { type: 'string', description: 'The exact text to replace (include enough context to be unique).' },
          new_string: { type: 'string', description: 'The replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file (moved to trash).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the workspace root.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_file',
      description: 'Rename or move a file within the workspace.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Current path relative to the workspace root.' },
          to: { type: 'string', description: 'New path relative to the workspace root.' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description: 'Return linter/compiler errors and warnings for a file (or the whole workspace).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Optional file path. Omit for all files.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch the text content of an http(s) URL (e.g. to check docs or latest versions).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The http(s) URL to fetch.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web (DuckDuckGo) and return titles, URLs and snippets. Use fetch_url afterwards to read a result.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
          limit: { type: 'number', description: 'Max results (default 6).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_script',
      description:
        'Write a temporary script and run it to test or verify something. The script is created in a temp directory, executed in the workspace root, and deleted afterwards — it never clutters the project.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', description: 'One of: bash, sh, zsh, python, node.' },
          code: { type: 'string', description: 'The script source code.' },
        },
        required: ['language', 'code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace root and return its output. Set background=true for long-running processes (e.g. dev servers): the command keeps running and you get a process id to poll with check_process.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute.' },
          background: { type: 'boolean', description: 'Run in the background and return immediately (default false).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_process',
      description: 'Check a background process started by run_command: returns its status and output so far.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The process id returned by run_command.' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_process',
      description: 'Stop a background process started by run_command.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The process id returned by run_command.' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description:
        'Open an http(s) URL in a headless browser (uses the locally installed Chrome/Edge). Returns the page title, text, and numbered interactive elements for browser_click / browser_type.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The http(s) URL to open.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Re-read the current browser page: title, visible text, and numbered interactive elements.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an interactive element by its [ref] number from the latest browser snapshot.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'number', description: 'Element number from the snapshot, e.g. 3.' } },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input element by its [ref] number; optionally press Enter afterwards.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'number', description: 'Element number from the snapshot.' },
          text: { type: 'string', description: 'The text to type.' },
          submit: { type: 'boolean', description: 'Press Enter after typing (default false).' },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the current browser page. It is described through the local vision toolchain so you can inspect the visual result.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: 'Close the headless browser when you are done with web automation.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description:
        'Search the project memory of key outcomes from earlier sessions to see what the user did before. Call this at the start of a task when past context could help.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional keywords to search for. Omit to get the most recent outcomes.' },
          limit: { type: 'number', description: 'Max number of entries to return (default 5).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description:
        'Record a durable key outcome so future sessions remember it (e.g. an important decision, what was built, or a gotcha). Keep the summary concise.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title of the outcome.' },
          summary: { type: 'string', description: 'Concise description of the key outcome worth remembering.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Optional related file paths.' },
        },
        required: ['title', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_rule',
      description: 'Load the full text of a project rule by name.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The rule name.' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description: 'Load the full instructions of a skill by name before using it.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The skill name.' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_plan',
      description:
        'Show/update your task plan in the UI. Call it at the start of a multi-step task with all steps, then again whenever a step finishes (mark it "done" and the next one "active"). Always pass the FULL list.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'The complete plan.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Short step description.' },
                status: { type: 'string', enum: ['pending', 'active', 'done'], description: 'Current step status.' },
              },
              required: ['text', 'status'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the user a clarifying question when requirements are ambiguous, instead of guessing. The user answers via single choice, multiple choice, or free text.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user.' },
          type: {
            type: 'string',
            enum: ['single', 'multiple', 'text'],
            description: "Answer type: 'single' (pick one), 'multiple' (pick several), or 'text' (free text).",
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'The choices for single/multiple questions. Omit for free-text questions.',
          },
        },
        required: ['question'],
      },
    },
  },
];

/**
 * The core subset for small models: fewer schemas keep the prompt short and
 * measurably improve tool-call accuracy of ~7B models.
 */
const REDUCED_TOOL_NAMES = new Set([
  'read_file',
  'list_dir',
  'search_files',
  'semantic_search',
  'write_file',
  'edit_file',
  'run_command',
  'get_diagnostics',
  'ask_user',
]);

/** Model-size heuristic: ids like "qwen2.5-coder:7b" → 7. */
export function parameterBillions(modelId: string): number | undefined {
  const match = modelId.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/);
  return match ? Number(match[1]) : undefined;
}

/** Resolves the schemas to offer, honoring the configured profile. */
export function schemasForModel(profile: ToolProfile, modelId: string): ToolSchema[] {
  let reduced = false;
  switch (profile) {
    case 'full':
      reduced = false;
      break;
    case 'reduced':
      reduced = true;
      break;
    case 'auto': {
      const size = parameterBillions(modelId);
      reduced = size !== undefined && size <= 8;
      break;
    }
    default: {
      const exhaustive: never = profile;
      void exhaustive;
    }
  }
  return reduced ? toolSchemas.filter((t) => REDUCED_TOOL_NAMES.has(t.function.name)) : toolSchemas;
}
