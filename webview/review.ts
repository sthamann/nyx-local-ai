import type { ReviewFile } from '../src/types';
import { changesBtn, changesCount, reviewBackBtn, reviewCommitBtn, reviewList, reviewRevertAllBtn, showView } from './dom';
import { post, S } from './state';

let lastReview: ReviewFile[] = [];

/** Updates the "N changed" chip from the current session's meta. */
export function updateChangesChip(): void {
  const current = S.currentSessionId ? S.sessions.find((s) => s.id === S.currentSessionId) : undefined;
  const count = current?.changedFiles ?? 0;
  changesBtn.hidden = count === 0;
  changesCount.textContent = `${count} changed`;
}

export function renderReview(files: ReviewFile[]): void {
  lastReview = files;
  reviewList.innerHTML = '';
  reviewCommitBtn.disabled = files.length === 0;
  reviewCommitBtn.textContent = 'Commit';
  reviewRevertAllBtn.disabled = files.length === 0;

  if (files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'nyx-empty';
    empty.innerHTML =
      '<div class="nyx-empty-title">No pending changes</div>' +
      '<div class="nyx-empty-sub">Everything the agent changed in this chat has been reverted or matches the session start.</div>';
    reviewList.appendChild(empty);
    return;
  }

  for (const file of files) {
    const card = document.createElement('div');
    card.className = 'nyx-review-file';

    const head = document.createElement('div');
    head.className = 'nyx-review-head';

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'nyx-file-link nyx-review-path';
    name.textContent = file.path;
    name.title = `Open ${file.path}`;
    name.addEventListener('click', () => post({ type: 'openFile', path: file.path }));

    const badge = document.createElement('span');
    badge.className = 'nyx-tool-badge';
    badge.innerHTML = file.deleted
      ? '<span class="nyx-badge-del">deleted</span>'
      : `${file.created ? '<span class="nyx-review-new">new</span> ' : ''}<span class="nyx-badge-add">+${file.diff.added}</span> <span class="nyx-badge-del">\u2212${file.diff.removed}</span>`;

    const revert = document.createElement('button');
    revert.type = 'button';
    revert.className = 'nyx-btn secondary nyx-review-revert';
    revert.textContent = 'Revert';
    revert.title = file.created ? 'Delete this file (it did not exist at session start)' : 'Restore the session-start content';
    revert.addEventListener('click', () => {
      revert.disabled = true;
      post({ type: 'revertFile', path: file.path });
    });

    head.appendChild(name);
    head.appendChild(badge);
    head.appendChild(revert);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'nyx-tool-body nyx-diff nyx-review-diff';
    for (const line of file.diff.preview) {
      const row = document.createElement('div');
      const marker = line.charAt(0);
      row.className = marker === '+' ? 'nyx-diff-add' : marker === '-' ? 'nyx-diff-del' : marker === '~' ? 'nyx-diff-note' : 'nyx-diff-ctx';
      row.textContent = line;
      body.appendChild(row);
    }
    card.appendChild(body);
    reviewList.appendChild(card);
  }
}

export function openReview(): void {
  post({ type: 'getReview' });
  renderReview(lastReview);
  showView('review');
}

export function initReview(): void {
  changesBtn.addEventListener('click', openReview);
  reviewBackBtn.addEventListener('click', () => showView('chat'));
  reviewRevertAllBtn.addEventListener('click', () => {
    reviewRevertAllBtn.disabled = true;
    post({ type: 'revertAll' });
  });
  reviewCommitBtn.addEventListener('click', () => {
    reviewCommitBtn.disabled = true;
    reviewCommitBtn.textContent = 'Committing…';
    post({ type: 'commitChanges' });
  });
}

