// PROTOTYPE ONLY — three variants of the composed migration-guide experience,
// switchable via ?variant=, on one static route.

const versions = [
  {
    id: 'v2.1',
    label: '2.1',
    status: 'In development',
    branch: 'main',
    sha: '6115a3e',
    records: [
      {
        id: 'adopt-locale-aware-labels',
        title: 'Adopt locale-aware label normalization',
        summary: 'Choose a locale when labels must follow locale-specific casing rules.',
        affected:
          'Consumers that need labels to follow casing rules for a locale other than the default en-US behavior.',
        migration: `
          <p>Pass the desired locale as the second argument to <code>normalizeLabel</code>:</p>
          <pre><code>normalizeLabel(' İSTANBUL ', 'tr');</code></pre>
          <p>Consumers that want the existing default do not need to change anything.</p>
        `,
        automation: null,
        source: 'migration-notes/v2.1/adopt-locale-aware-labels.md',
        real: true,
        tag: 'Core',
      },
      {
        id: 'declare-summary-locale',
        title: 'Declare the addon summary locale',
        summary: 'Keep addon summaries aligned with the locale used by the core formatter.',
        affected:
          'Addon consumers that pass localized labels through summary helpers or snapshot their formatted output.',
        migration: `
          <p>Forward the application locale when creating a summary:</p>
          <pre><code>createSummary({ label, locale: 'tr' });</code></pre>
          <p>Review snapshots that intentionally depended on the former default.</p>
        `,
        automation: 'Run npx @fablebook/codemod add-summary-locale',
        source: 'migration-notes/v2.1/declare-summary-locale.md',
        real: false,
        tag: 'Addon',
      },
      {
        id: 'remove-legacy-label-trimming',
        title: 'Remove manual label trimming',
        summary: 'Avoid applying legacy whitespace cleanup before normalization.',
        affected:
          'Integrations that trim or lowercase labels immediately before passing them to Lab-02 core.',
        migration: `
          <p>Pass the original label to <code>normalizeLabel</code> and remove the redundant preparation step:</p>
          <pre><code>// Before
normalizeLabel(label.trim().toLowerCase());

// After
normalizeLabel(label, locale);</code></pre>
        `,
        automation: null,
        source: 'migration-notes/v2.1/remove-legacy-label-trimming.md',
        real: false,
        tag: 'Core',
      },
    ],
  },
  {
    id: 'v2.0',
    label: '2.0',
    status: 'Latest stable',
    branch: 'v2.0.3',
    sha: 'v2.0.3',
    records: [
      {
        id: 'move-to-normalize-label',
        title: 'Move to normalizeLabel',
        summary: 'Replace direct label cleanup with the public normalization API.',
        affected: 'Consumers calling the former internal label cleanup helper.',
        migration: `
          <p>Import <code>normalizeLabel</code> from the package root and replace the internal helper call.</p>
          <pre><code>import { normalizeLabel } from '@fablebook/lab-02-core';</code></pre>
        `,
        automation: null,
        source: 'migration-notes/v2.0/move-to-normalize-label.md',
        real: false,
        tag: 'Core',
      },
    ],
  },
];

const variants = {
  A: {
    name: 'Repository index',
    host: 'GitHub branch files',
    verdict: 'Smallest host; source paths are the product surface.',
  },
  B: {
    name: 'Version handbook',
    host: 'Static Pages projection',
    verdict: 'Composed reading is primary; every section keeps a direct record route.',
  },
  C: {
    name: 'Record catalog',
    host: 'Docs-ready static projection',
    verdict: 'Direct records are primary; the version guide is an ordered playlist.',
  },
};

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const state = () => {
  const params = new URLSearchParams(location.search);
  const variant = Object.hasOwn(variants, params.get('variant')) ? params.get('variant') : 'A';
  const version = versions.find(({ id }) => id === params.get('version')) ?? versions[0];
  const record = version.records.find(({ id }) => id === params.get('record')) ?? null;
  return { params, record, variant, version };
};

const hrefFor = ({ variant, version, record = null }) => {
  const params = new URLSearchParams();
  params.set('variant', variant);
  params.set('version', version.id);
  if (record) params.set('record', record.id);
  return `/?${params}`;
};

const sourceUrl = (version, record) =>
  record.real
    ? `https://github.com/fablebookjs/lab-02/blob/${version.branch}/${record.source}`
    : '#prototype-fixture';

const provenance = (version, label = 'Guide source') => `
  <div class="provenance">
    <span class="pulse"></span>
    <strong>${label}</strong>
    <code>${escapeHtml(version.branch)} @ ${escapeHtml(version.sha)}</code>
  </div>
`;

const recordMeta = (record) => `
  <div class="record-meta">
    <span class="tag">${escapeHtml(record.tag)}</span>
    ${record.automation ? '<span class="tag tag-accent">Codemod available</span>' : ''}
    ${record.real ? '' : '<span class="tag tag-muted">Illustrative fixture</span>'}
  </div>
`;

const recordBody = (record, headingLevel = 2) => `
  ${recordMeta(record)}
  <h${headingLevel}>${escapeHtml(record.title)}</h${headingLevel}>
  <h${headingLevel + 1}>Who is affected</h${headingLevel + 1}>
  <p>${escapeHtml(record.affected)}</p>
  <h${headingLevel + 1}>How to migrate</h${headingLevel + 1}>
  ${record.migration}
  ${
    record.automation
      ? `<h${headingLevel + 1}>Automatic migration</h${headingLevel + 1}><p>${escapeHtml(record.automation)}</p>`
      : ''
  }
`;

const versionLinks = (variant, current) =>
  versions
    .map(
      (version) => `
        <a class="version-link ${version.id === current.id ? 'is-active' : ''}"
           href="${hrefFor({ variant, version })}">
          <span>v${version.label}</span>
          <small>${version.records.length} ${version.records.length === 1 ? 'record' : 'records'}</small>
        </a>
      `
    )
    .join('');

const renderRepositoryIndex = ({ variant, version, record }) => {
  if (record) {
    return `
      <div class="github-shell">
        <header class="repo-header">
          <a href="${hrefFor({ variant, version })}" class="repo-name">fablebookjs / <strong>lab-02</strong></a>
          <span class="visibility">Public</span>
        </header>
        <div class="repo-toolbar">
          <a href="${hrefFor({ variant, version })}">migration-notes</a>
          <span>/</span><a href="${hrefFor({ variant, version })}">${version.id}</a>
          <span>/</span><strong>${record.id}.md</strong>
          <span class="spacer"></span><span class="branch-chip">⑂ ${version.branch}</span>
        </div>
        <article class="github-markdown focused-record">
          ${recordBody(record, 1)}
          <footer class="source-footer">
            <span>${escapeHtml(record.source)}</span>
            <a href="${sourceUrl(version, record)}">${record.real ? 'View exact source ↗' : 'Prototype fixture'}</a>
          </footer>
        </article>
      </div>
    `;
  }

  return `
    <div class="github-shell">
      <header class="repo-header">
        <span class="repo-name">fablebookjs / <strong>lab-02</strong></span>
        <span class="visibility">Public</span>
      </header>
      <div class="repo-toolbar">
        <span>migration-notes /</span>
        <select data-version-select aria-label="Target version">
          ${versions
            .map(
              (candidate) =>
                `<option value="${candidate.id}" ${candidate.id === version.id ? 'selected' : ''}>${candidate.id}</option>`
            )
            .join('')}
        </select>
        <span class="spacer"></span><span class="branch-chip">⑂ ${version.branch}</span>
      </div>
      <div class="file-table">
        ${version.records
          .map(
            (item) => `
              <a class="file-row" href="${hrefFor({ variant, version, record: item })}">
                <span class="file-icon">▤</span>
                <strong>${item.id}.md</strong>
                <span>${escapeHtml(item.summary)}</span>
                <time>${item.real ? 'source file' : 'fixture'}</time>
              </a>
            `
          )
          .join('')}
      </div>
      <article class="github-markdown readme">
        ${provenance(version, 'Rendered index')}
        <h1>Migration guide for ${version.id}</h1>
        <p class="lede">Read these migrations in order when adopting ${version.id}. Each title opens the durable source record.</p>
        <ol class="repo-composition">
          ${version.records
            .map(
              (item) => `
                <li>
                  <a href="${hrefFor({ variant, version, record: item })}">${escapeHtml(item.title)}</a>
                  <p>${escapeHtml(item.summary)}</p>
                </li>
              `
            )
            .join('')}
        </ol>
        <aside class="prototype-note">
          <strong>Hosting shape</strong>
          No separate site. GitHub hosts both direct records and a generated version index on the branch.
        </aside>
      </article>
    </div>
  `;
};

const renderVersionHandbook = ({ variant, version, record }) => {
  const content = record
    ? `
      <div class="docs-breadcrumbs">
        <a href="${hrefFor({ variant, version })}">Migration guide ${version.id}</a><span>/</span><span>${escapeHtml(record.title)}</span>
      </div>
      <article class="docs-article direct-doc">
        ${provenance(version, 'Rendered from')}
        ${recordBody(record, 1)}
        <div class="doc-actions">
          <a href="${sourceUrl(version, record)}">${record.real ? 'Edit this Markdown on GitHub ↗' : 'Illustrative prototype record'}</a>
          <a href="${hrefFor({ variant, version })}">Back to the complete ${version.id} guide</a>
        </div>
      </article>
    `
    : `
      <div class="docs-breadcrumbs"><span>Migration guides</span><span>/</span><span>${version.id}</span></div>
      <article class="docs-article">
        ${provenance(version, 'Built from')}
        <p class="eyebrow">${escapeHtml(version.status)}</p>
        <h1>Upgrade to Lab-02 ${version.label}</h1>
        <p class="hero-copy">A composed path through ${version.records.length} independent migration records. Read top to bottom, or share any record directly.</p>
        <div class="reading-summary">
          <span><strong>${version.records.length}</strong> migrations</span>
          <span><strong>${version.records.filter(({ automation }) => automation).length}</strong> automated</span>
          <span><strong>~${version.records.length * 3} min</strong> reading</span>
        </div>
        ${version.records
          .map(
            (item, index) => `
              <section class="composed-record" id="${item.id}">
                <div class="step-number">${String(index + 1).padStart(2, '0')}</div>
                <div class="composed-content">
                  ${recordBody(item, 2)}
                  <a class="permalink" href="${hrefFor({ variant, version, record: item })}">Open this migration on its own →</a>
                </div>
              </section>
            `
          )
          .join('')}
        <aside class="prototype-note">
          <strong>Hosting shape</strong>
          A static GitHub Pages build turns branch Markdown into clean version and direct-record routes. The renderer is replaceable by Storybook docs later.
        </aside>
      </article>
    `;

  return `
    <div class="docs-shell">
      <header class="docs-header">
        <a href="${hrefFor({ variant, version })}" class="wordmark"><span>F</span> Fablebook Lab</a>
        <nav><a class="is-current">Migration guides</a><a>Releases</a><a>Source ↗</a></nav>
      </header>
      <div class="docs-grid">
        <aside class="docs-sidebar">
          <p class="sidebar-label">Target version</p>
          ${versionLinks(variant, version)}
          <div class="branch-card">
            <span>Source branch</span><code>${escapeHtml(version.branch)}</code>
            <small>Pages rebuilds from this ref</small>
          </div>
        </aside>
        <main>${content}</main>
        <aside class="toc">
          <p>On this page</p>
          ${
            record
              ? `<a>Who is affected</a><a>How to migrate</a>${record.automation ? '<a>Automatic migration</a>' : ''}`
              : version.records
                  .map(
                    (item) =>
                      `<a href="#${item.id}">${escapeHtml(item.title)}</a>`
                  )
                  .join('')
          }
        </aside>
      </div>
    </div>
  `;
};

const renderRecordCatalog = ({ variant, version, record }) => {
  const active = record ?? version.records[0];
  return `
    <div class="catalog-shell">
      <header class="catalog-header">
        <div>
          <p class="eyebrow">Lab-02 migration library</p>
          <h1>Find the change you need to make.</h1>
        </div>
        ${provenance(version, 'Catalog source')}
      </header>
      <div class="catalog-version-bar">
        <div class="segmented">
          ${versions
            .map(
              (candidate) => `
                <a class="${candidate.id === version.id ? 'is-active' : ''}"
                   href="${hrefFor({ variant, version: candidate })}">${candidate.id}</a>
              `
            )
            .join('')}
        </div>
        <a class="playlist-link ${record ? '' : 'is-active'}" href="${hrefFor({ variant, version })}">
          ${record ? `View all ${version.records.length} in order` : `Reading all ${version.records.length} in order`}
        </a>
      </div>
      <div class="catalog-layout">
        <aside class="record-list">
          <p class="sidebar-label">${version.id} migration records</p>
          ${version.records
            .map(
              (item, index) => `
                <a class="record-card ${active.id === item.id ? 'is-active' : ''}"
                   href="${hrefFor({ variant, version, record: item })}">
                  <span>${String(index + 1).padStart(2, '0')}</span>
                  <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.summary)}</small></div>
                  <b>→</b>
                </a>
              `
            )
            .join('')}
        </aside>
        <main class="record-reader">
          <div class="reader-topline">
            <span>${record ? 'Direct migration record' : `First of ${version.records.length} · composed order`}</span>
            <a href="${sourceUrl(version, active)}">${active.real ? active.source : 'Illustrative fixture'}</a>
          </div>
          <article>
            ${recordBody(active, 1)}
            <div class="doc-actions">
              ${
                record
                  ? `<a href="${hrefFor({ variant, version })}">Start the complete ${version.id} migration path</a>`
                  : `<a href="${hrefFor({ variant, version, record: active })}">Share this record directly</a>`
              }
            </div>
          </article>
          ${
            record
              ? ''
              : `
                <div class="up-next">
                  <span>Up next</span>
                  ${version.records
                    .slice(1)
                    .map(
                      (item, index) => `
                        <a href="${hrefFor({ variant, version, record: item })}">
                          <span>${String(index + 2).padStart(2, '0')}</span>
                          <strong>${escapeHtml(item.title)}</strong><b>→</b>
                        </a>
                      `
                    )
                    .join('')}
                </div>
              `
          }
        </main>
        <aside class="catalog-rationale">
          <strong>Hosting shape</strong>
          <p>A tiny static catalog reads build-time data emitted from Markdown. Its route/data contract is designed to move into Storybook docs later.</p>
          <dl><dt>Version route</dt><dd>/migrations/${version.id}</dd><dt>Direct route</dt><dd>/migrations/${version.id}/${active.id}</dd></dl>
        </aside>
      </div>
    </div>
  `;
};

const switcher = (variant) => {
  const keys = Object.keys(variants);
  const index = keys.indexOf(variant);
  const previous = keys[(index - 1 + keys.length) % keys.length];
  const next = keys[(index + 1) % keys.length];
  return `
    <div class="prototype-switcher" role="navigation" aria-label="Prototype variants">
      <a href="#" data-variant="${previous}" aria-label="Previous variant">←</a>
      <div>
        <span>PROTOTYPE</span>
        <strong>${variant} — ${variants[variant].name}</strong>
        <small>${variants[variant].host}</small>
      </div>
      <a href="#" data-variant="${next}" aria-label="Next variant">→</a>
    </div>
  `;
};

const render = () => {
  const current = state();
  const renderVariant = {
    A: renderRepositoryIndex,
    B: renderVersionHandbook,
    C: renderRecordCatalog,
  }[current.variant];
  document.querySelector('#app').innerHTML = `
    ${renderVariant(current)}
    ${switcher(current.variant)}
  `;
};

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-variant]');
  if (!target) return;
  event.preventDefault();
  const { params } = state();
  params.set('variant', target.dataset.variant);
  history.replaceState(null, '', `/?${params}`);
  render();
});

document.addEventListener('change', (event) => {
  if (!event.target.matches('[data-version-select]')) return;
  const { variant } = state();
  const version = versions.find(({ id }) => id === event.target.value);
  location.href = hrefFor({ variant, version });
});

document.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  if (event.target.closest('input, textarea, select, [contenteditable]')) return;
  const { variant, params } = state();
  const keys = Object.keys(variants);
  const delta = event.key === 'ArrowLeft' ? -1 : 1;
  const next = keys[(keys.indexOf(variant) + delta + keys.length) % keys.length];
  params.set('variant', next);
  history.replaceState(null, '', `/?${params}`);
  render();
});

window.addEventListener('popstate', render);
render();
