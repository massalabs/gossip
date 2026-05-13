import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const consoleCallPattern =
  /(?:[A-Za-z_$][\w$]*\.)?console\.(?:log|debug|info|warn|error)\s*\(/g;

function stripConsoleCalls(source) {
  let output = '';
  let cursor = 0;

  for (const match of source.matchAll(consoleCallPattern)) {
    const start = match.index;
    let index = start + match[0].length;
    let depth = 1;
    let quote = null;

    while (index < source.length && depth > 0) {
      const char = source[index];
      const prev = source[index - 1];

      if (quote) {
        if (char === quote && prev !== '\\') quote = null;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '(') {
        depth++;
      } else if (char === ')') {
        depth--;
      }

      index++;
    }

    output += source.slice(cursor, start);
    output += 'void 0';
    cursor = index;
  }

  output += source.slice(cursor);
  return output;
}

for (const file of ['dist/sw.js', 'dist/sw.mjs']) {
  if (!existsSync(file)) continue;
  const source = readFileSync(file, 'utf8');
  const transformed = transformSync(source, {
    loader: 'js',
    target: 'esnext',
    format: 'esm',
    drop: ['console', 'debugger'],
    minify: true,
  }).code;
  writeFileSync(file, stripConsoleCalls(transformed));
}
