// Comment-hygiene gates (contract-first comments, see AGENTS.md): a no-comment-slop
// subset plus a legibility comment-only subset over src/ and public/. Product-code
// lines are out of scope for this gate: no legibility code-shape rules are enabled.
//
// Calibration 2026-10-09 (2705 report-only hits): the three warn rules below carry
// the legacy backlog and stay advisory until the owner works through the counted
// follow-up list. The error rules had zero hits on that pass, so they hold for new
// code from day one.
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
        // Advisory backlog (2565 hits): consecutive `//` lines are this repo's
        // normal multi-line idiom, so error-level would demand a whole-tree
        // rewrite. Warns on new stacks without failing the gate.
        'legibility/no-stacked-comments': 'warn',
        // Advisory backlog (103 hits): `// ---- name ----` section banners are
        // module structure (see ADR-013: split along existing section banners).
        // Removing them tree-wide is an owner design decision, not gate fallout.
        'no-comment-slop/no-banner-comment': 'warn',
        // Advisory backlog (37 blocks over 10 lines): trim opportunistically to
        // contract + `see ADR-NNN` pointers, five spots per change at most.
        'no-comment-slop/max-comment-lines': ['warn', { max: 10 }],
        // Known false positives on this repo's per-row db.prepare loops in
        // resolveAction/actionFiles/profile reads: documented, not debated.
        'legibility/no-quadratic-patterns': 'off',
        'legibility/no-repeated-collection-search': 'off',
      },
    },
  ];
})();
