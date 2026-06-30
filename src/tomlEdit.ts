/**
 * A deliberately tiny TOML editor scoped to ONE job: read, upsert, or remove a
 * single `[mcp_servers.<key>]` table in a codex config file while leaving the
 * rest of the user's file untouched.
 *
 * We do NOT parse arbitrary TOML. Codex's config can contain anything, and a
 * lossy round-trip through a generic parser would drop comments, reorder keys,
 * and rewrite formatting the user cares about. Instead we treat the file as
 * text and operate on the contiguous line-span of our own table. We only ever
 * read back values WE wrote (command/args/env in the exact shape serializeBlock
 * emits), so a full TOML value parser is unnecessary.
 *
 * Tested by tomlEdit.test.ts (run: `node out-test/tomlEdit.test.js` after tsc,
 * or via the inline harness at the bottom of that file).
 */

export interface CodexStdioEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** TOML basic-string escaping for a double-quoted value. */
function tomlStr(s: string): string {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** Reverse of tomlStr for the value forms we emit. Returns undefined on malformed. */
function parseTomlStr(raw: string): string | undefined {
  const t = raw.trim();
  if (t.length < 2 || t[0] !== '"' || t[t.length - 1] !== '"') return undefined;
  const inner = t.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\') {
      const n = inner[++i];
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === '"') out += '"';
      else if (n === '\\') out += '\\';
      else out += n; // unknown escape: keep literal
    } else {
      out += c;
    }
  }
  return out;
}

/** Header line that opens our table, e.g. `[mcp_servers.vscode-debug]`. */
function headerFor(key: string): string {
  // Bare key if it's a clean identifier; quoted otherwise (TOML dotted-key rules).
  const bare = /^[A-Za-z0-9_-]+$/.test(key);
  const k = bare ? key : tomlStr(key);
  return `[mcp_servers.${k}]`;
}

/** Serialize our entry as the body lines under the table header (inclusive of header). */
export function serializeBlock(key: string, entry: CodexStdioEntry): string {
  const lines: string[] = [headerFor(key)];
  lines.push(`command = ${tomlStr(entry.command)}`);
  const args = entry.args.map(tomlStr).join(', ');
  lines.push(`args = [${args}]`);
  const envKeys = Object.keys(entry.env);
  if (envKeys.length > 0) {
    const inline = envKeys.map((k) => `${k} = ${tomlStr(entry.env[k])}`).join(', ');
    lines.push(`env = { ${inline} }`);
  }
  return lines.join('\n');
}

/** Strip a trailing inline comment that is not inside a string. Cheap heuristic for our own simple lines. */
function stripComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      // count preceding backslashes for escape
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && line[j] === '\\') { bs++; j--; }
      if (bs % 2 === 0) inStr = !inStr;
    } else if (c === '#' && !inStr) {
      return line.slice(0, i);
    }
  }
  return line;
}

interface BlockSpan {
  /** index of the header line in the lines array */
  start: number;
  /** exclusive end index — first line that does NOT belong to our table */
  end: number;
}

/** Find the line-span of `[mcp_servers.<key>]` ... up to the next table header / EOF. */
function findBlock(lines: string[], key: string): BlockSpan | undefined {
  const wantBare = headerFor(key);
  // Accept either the bare or quoted header spelling regardless of how we'd emit it.
  const altKey = /^[A-Za-z0-9_-]+$/.test(key) ? tomlStr(key) : key;
  const wantAlt = `[mcp_servers.${altKey}]`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = stripComment(lines[i]).trim();
    if (t === wantBare || t === wantAlt) { start = i; break; }
  }
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const t = stripComment(lines[i]).trim();
    // A new table header (any [..] or [[..]]) ends our block.
    if (/^\[\[?[^\]]+\]\]?$/.test(t)) { end = i; break; }
  }
  return { start, end };
}

/** Read the value of a simple `key = ...` line within a block; returns the raw RHS. */
function rhs(line: string): string | undefined {
  const t = stripComment(line);
  const eq = t.indexOf('=');
  if (eq === -1) return undefined;
  return t.slice(eq + 1).trim();
}

/**
 * Read our entry back from a codex config, or undefined if our table is absent.
 * Only understands the value shapes serializeBlock emits.
 */
export function readBlock(content: string, key: string): CodexStdioEntry | undefined {
  const lines = content.split('\n');
  const span = findBlock(lines, key);
  if (!span) return undefined;
  let command: string | undefined;
  let args: string[] = [];
  const env: Record<string, string> = {};
  for (let i = span.start + 1; i < span.end; i++) {
    const t = stripComment(lines[i]).trim();
    if (t.startsWith('command')) {
      const v = rhs(lines[i]);
      if (v) command = parseTomlStr(v);
    } else if (t.startsWith('args')) {
      const v = rhs(lines[i]);
      if (v && v.startsWith('[') && v.endsWith(']')) {
        const inner = v.slice(1, -1).trim();
        args = inner.length
          ? splitTopLevel(inner)
              .map((s) => parseTomlStr(s))
              .filter((s): s is string => s !== undefined)
          : [];
      }
    } else if (t.startsWith('env')) {
      const v = rhs(lines[i]);
      if (v && v.startsWith('{') && v.endsWith('}')) {
        const inner = v.slice(1, -1).trim();
        if (inner.length) {
          for (const pair of splitTopLevel(inner)) {
            const eq = pair.indexOf('=');
            if (eq === -1) continue;
            const k = pair.slice(0, eq).trim();
            const val = parseTomlStr(pair.slice(eq + 1));
            if (k && val !== undefined) env[k] = val;
          }
        }
      }
    }
  }
  if (command === undefined) return undefined;
  return { command, args, env };
}

/** Split an inline-table body on top-level commas (not inside quoted strings). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      let bs = 0; let j = i - 1;
      while (j >= 0 && s[j] === '\\') { bs++; j--; }
      if (bs % 2 === 0) inStr = !inStr;
      cur += c;
    } else if (c === ',' && !inStr) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim().length) out.push(cur);
  return out;
}

/**
 * Upsert our table into the codex config text. Preserves all other content. If
 * our table already exists, its line-span is replaced in place; otherwise the
 * table is appended (with a separating blank line if the file is non-empty).
 */
export function upsertBlock(content: string, key: string, entry: CodexStdioEntry): string {
  const block = serializeBlock(key, entry);
  if (content.trim().length === 0) {
    return block + '\n';
  }
  const lines = content.split('\n');
  const span = findBlock(lines, key);
  if (span) {
    // Replace [start, end) with our freshly-serialized block.
    const before = lines.slice(0, span.start);
    const after = lines.slice(span.end);
    const merged = [...before, ...block.split('\n'), ...after];
    return merged.join('\n');
  }
  // Append. Ensure exactly one blank line before our block.
  const trimmedRight = content.replace(/\s*$/, '');
  return `${trimmedRight}\n\n${block}\n`;
}

/**
 * Remove our table from the codex config text. Also collapses a single blank
 * line left behind so we don't accumulate gaps across install/uninstall cycles.
 * Returns the new content and whether anything was removed.
 */
export function removeBlock(content: string, key: string): { content: string; removed: boolean } {
  const lines = content.split('\n');
  const span = findBlock(lines, key);
  if (!span) return { content, removed: false };
  const before = lines.slice(0, span.start);
  const after = lines.slice(span.end);
  // Drop a trailing blank line from `before` OR a leading blank from `after`
  // so removing a mid-file block doesn't leave a double gap.
  if (before.length && before[before.length - 1].trim() === '') before.pop();
  else if (after.length && after[0].trim() === '') after.shift();
  let merged = [...before, ...after].join('\n');
  // Guarantee a single trailing newline for a non-empty file.
  merged = merged.replace(/\s*$/, '');
  if (merged.length) merged += '\n';
  return { content: merged, removed: true };
}
