// Comment-hygiene gates (contract-first comments, see AGENTS.md): a no-comment-slop
// subset plus a legibility comment-only subset over src/ and public/. Product-code
// lines are out of scope for this gate: no legibility code-shape rules are enabled.
//
// Calibration 2026-10-09 (2705 report-only hits) + owner-approved off: stacked/banner
// rules below are repo idiom, not backlog. The error rules hold for new code.
module.exports = (async () => {
  const noCommentSlop = (await import('eslint-plugin-no-comment-slop')).default;
  const legibility = (await import('eslint-plugin-legibility')).default;
  return [
    {
      ignores: ['node_modules/**', 'fixtures/**', 'Temp/**', 'dist/**'],
    },
    {
      files: ['src/**/*.js', 'public/**/*.js'],
      plugins: {
        'no-comment-slop': noCommentSlop,
        legibility,
      },
      rules: {
        // Enforced: clean on calibration day, so every new violation fails the gate.
        'no-comment-slop/no-jargon': 'error',
        'legibility/require-jsdoc-multiline-comments': 'error',
        'legibility/no-automated-comment-attribution': 'error',
        // stacked multi-line `//` is this repo's normal idiom (e.g. XML-entity explanation in public/app.js).
        'legibility/no-stacked-comments': 'off',
        // `// ---- name ----` banners are module structure that ADR-013 says to split along.
        'no-comment-slop/no-banner-comment': 'off',
        // Enforced: trimmed to contract + `see ADR-NNN` pointers, so every new
        // overlong block fails the gate.
        'no-comment-slop/max-comment-lines': ['error', { max: 10 }],
        // Known false positives on this repo's per-row db.prepare loops in
        // resolveAction/actionFiles/profile reads: documented, not debated.
        'legibility/no-quadratic-patterns': 'off',
        'legibility/no-repeated-collection-search': 'off',
      },
    },
  ];
})();
