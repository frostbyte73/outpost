import { escapeHtml } from '../../util.js';
import { settings } from '../../state/settings.js';
import { detailShell, block } from './detail-shell.js';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Mirrors isReviewerEntry in src/git/pr-reviewers.ts
const REVIEWER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export function parseRepo(input) {
  const s = input.trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  return REPO_RE.test(s) ? s.toLowerCase() : null;
}

export function renderPrReviews(mount) {
  const body = detailShell(
    mount,
    'PR reviews',
    'Opens a review job for each pull request somebody else opens. Its plan waits for your approval, and nothing is posted to GitHub without approving the draft.',
  );
  const requestedSection = block(body, 'Review requested', `
    <div class="settings-segmented" data-role="review-requested">
      <button type="button" data-value="off">Off</button>
      <button type="button" data-value="on">On</button>
    </div>
    <p class="settings-note">Any open PR, in any repo, that requests your review by name. Requests to a team you're on don't count.</p>
  `);
  const reposSection = block(body, 'Watched repos', `
    <div class="settings-projects" data-role="intake-repos"></div>
    <div class="settings-row">
      <input class="settings-row-input settings-row-input--wide" id="settings-intake-repo" type="text"
        spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="owner/repo" />
      <button type="button" class="o-btn o-btn--default sm" data-role="intake-add">Add</button>
    </div>
    <p class="settings-note">Every open PR in these repos that you didn't open, including ones already open when you add the repo. Checked every 10 minutes; drafts are skipped until marked ready.</p>
  `);
  const reviewersSection = block(body, 'Reviewers on your PRs', `
    <div class="settings-projects" data-role="pr-reviewers"></div>
    <div class="settings-row">
      <input class="settings-row-input settings-row-input--wide" id="settings-pr-reviewer" type="text"
        spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="org/team or username" />
      <button type="button" class="o-btn o-btn--default sm" data-role="reviewer-add">Add</button>
    </div>
    <p class="settings-note">Requested on every PR Outpost opens. A team is only requested in repos its org owns.</p>
  `);
  const rowsEl = reposSection.querySelector('[data-role="intake-repos"]');
  const input = reposSection.querySelector('#settings-intake-repo');
  const reviewerRowsEl = reviewersSection.querySelector('[data-role="pr-reviewers"]');
  const reviewerInput = reviewersSection.querySelector('#settings-pr-reviewer');

  function paint() {
    const { repos, reviewRequested } = settings.get().prReviewIntake;
    for (const btn of requestedSection.querySelectorAll('button[data-value]')) {
      btn.classList.toggle('active', btn.dataset.value === (reviewRequested ? 'on' : 'off'));
    }
    rowsEl.innerHTML = repos.length
      ? repos.map((r) => `
        <div class="settings-project-row">
          <span class="settings-project-cwd">${escapeHtml(r)}</span>
          <button type="button" class="o-btn o-btn--default sm settings-project-remove" data-repo="${escapeHtml(r)}">Remove</button>
        </div>`).join('')
      : '<p class="settings-note">No repos watched.</p>';
    const reviewers = settings.get().prReviewers;
    reviewerRowsEl.innerHTML = reviewers.length
      ? reviewers.map((r) => `
        <div class="settings-project-row">
          <span class="settings-project-cwd">${escapeHtml(r)}</span>
          <button type="button" class="o-btn o-btn--default sm settings-project-remove" data-reviewer="${escapeHtml(r)}">Remove</button>
        </div>`).join('')
      : '<p class="settings-note">No reviewers requested.</p>';
  }

  function addReviewer() {
    const reviewer = reviewerInput.value.trim().replace(/^@/, '');
    if (!REVIEWER_RE.test(reviewer)) {
      reviewerInput.setCustomValidity('Use org/team or a GitHub username');
      reviewerInput.reportValidity();
      return;
    }
    reviewerInput.setCustomValidity('');
    reviewerInput.value = '';
    const reviewers = settings.get().prReviewers;
    if (!reviewers.some((r) => r.toLowerCase() === reviewer.toLowerCase())) settings.setPrReviewers([...reviewers, reviewer]);
  }

  function update(patch) {
    settings.setPrReviewIntake({ ...settings.get().prReviewIntake, ...patch });
  }

  function addRepo() {
    const repo = parseRepo(input.value);
    if (!repo) {
      input.setCustomValidity('Use owner/repo');
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    input.value = '';
    const { repos } = settings.get().prReviewIntake;
    if (!repos.includes(repo)) update({ repos: [...repos, repo] });
  }

  requestedSection.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (btn) update({ reviewRequested: btn.dataset.value === 'on' });
  });
  reposSection.addEventListener('click', (e) => {
    if (e.target.closest('[data-role="intake-add"]')) { addRepo(); return; }
    const remove = e.target.closest('[data-repo]');
    if (remove) update({ repos: settings.get().prReviewIntake.repos.filter((r) => r !== remove.dataset.repo) });
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addRepo(); });
  input.addEventListener('input', () => input.setCustomValidity(''));
  reviewersSection.addEventListener('click', (e) => {
    if (e.target.closest('[data-role="reviewer-add"]')) { addReviewer(); return; }
    const remove = e.target.closest('[data-reviewer]');
    if (remove) settings.setPrReviewers(settings.get().prReviewers.filter((r) => r !== remove.dataset.reviewer));
  });
  reviewerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addReviewer(); });
  reviewerInput.addEventListener('input', () => reviewerInput.setCustomValidity(''));

  paint();
  return settings.subscribe(paint);
}
