export interface SqlMode {
  noBackslashEscapes?: boolean;
  ansiQuotes?: boolean;
}

interface Token {
  kind: 'word' | 'quoted' | 'literal' | 'parameter' | 'symbol';
  value: string;
  depth: number;
}

/** Tokenize SQL without treating quoted text or comments as executable tokens. */
export function tokenizeSql(sql: string, mode: SqlMode = {}): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let depth = 0;
  let terminated = false;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (
      c === '#' ||
      (sql.startsWith('--', i) && (sql[i + 2] === undefined || sql.charCodeAt(i + 2) <= 32))
    ) {
      const offset = sql.slice(i).search(/[\r\n]/);
      const end = offset < 0 ? -1 : i + offset;
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      if (/^\/\*(?:!|M!|\+)/i.test(sql.slice(i))) {
        throw new Error('Executable comments and optimizer hints are not permitted.');
      }
      const end = sql.indexOf('*/', i + 2);
      if (end < 0 || sql.slice(i + 2, end).includes('/*')) {
        throw new Error('Malformed or nested SQL comment.');
      }
      i = end + 2;
      continue;
    }
    if (terminated) throw new Error('Multiple statements are not allowed.');
    if (c === ';') {
      if (depth !== 0 || tokens.length === 0) throw new Error('Invalid statement delimiter.');
      terminated = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quoted = c === '`' || (c === '"' && mode.ansiQuotes);
      const start = i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        if (!quoted && sql[i] === '\\' && !mode.noBackslashEscapes) i += 2;
        else i++;
      }
      if (!closed) throw new Error('Unterminated SQL quote.');
      tokens.push({ kind: quoted ? 'quoted' : 'literal', value: sql.slice(start, i), depth });
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      tokens.push({ kind: 'word', value: sql.slice(start, i).toUpperCase(), depth });
      continue;
    }
    if (c === ')') {
      depth--;
      if (depth < 0) throw new Error('Unbalanced SQL parentheses.');
    }
    tokens.push({ kind: c === '?' ? 'parameter' : 'symbol', value: c, depth });
    if (c === '(') depth++;
    i++;
  }
  if (depth !== 0) throw new Error('Unbalanced SQL parentheses.');
  if (tokens.length === 0) throw new Error('SQL is empty');
  return tokens;
}

function validateParameters(tokens: Token[], params: unknown[] = []): void {
  if (tokens.filter((t) => t.kind === 'parameter').length !== params.length) {
    throw new Error('Parameter count does not match SQL placeholders.');
  }
}

/** Consume a CTE prefix, checking each query body and the final SELECT. */
function validateSelect(tokens: Token[], start: number, end: number, nesting = 0): void {
  const invalid = (): never => {
    throw new Error('WITH requires SELECT query bodies and a final SELECT statement.');
  };
  if (nesting > 64) invalid();
  let i = start;
  const word = (value: string) => tokens[i]?.kind === 'word' && tokens[i].value === value;
  const identifier = () => {
    const token = tokens[i++];
    if (
      !token ||
      !(token.kind === 'quoted' || (token.kind === 'word' && /^[A-Z_$]/.test(token.value)))
    )
      invalid();
  };
  if (word('WITH')) {
    i++;
    if (word('RECURSIVE')) i++;
    do {
      identifier();
      if (tokens[i]?.value === '(') {
        i++;
        identifier();
        while (tokens[i]?.value === ',') {
          i++;
          identifier();
        }
        if (tokens[i++]?.value !== ')') invalid();
      }
      if (!word('AS')) invalid();
      i++;
      const open = tokens[i++];
      if (open?.value !== '(') invalid();
      const bodyStart = i;
      while (i < end && !(tokens[i].value === ')' && tokens[i].depth === open.depth)) i++;
      if (i >= end || bodyStart === i) invalid();
      validateSelect(tokens, bodyStart, i, nesting + 1);
      i++;
      if (word('CYCLE')) {
        i++;
        identifier();
        while (tokens[i]?.value === ',') {
          i++;
          identifier();
        }
        if (!word('RESTRICT')) invalid();
        i++;
      }
      if (tokens[i]?.value !== ',') break;
      i++;
    } while (i < end);
  }
  if (i < end && tokens[i].value === '(') {
    const open = tokens[i++];
    const bodyStart = i;
    while (i < end && !(tokens[i].value === ')' && tokens[i].depth === open.depth)) i++;
    if (i >= end || bodyStart === i) invalid();
    validateSelect(tokens, bodyStart, i, nesting + 1);
    i++;
    if (i === end) return;
    if (word('ORDER') || word('LIMIT')) return;
    if (word('UNION') || word('INTERSECT') || word('EXCEPT')) {
      i++;
      if (word('ALL') || word('DISTINCT')) i++;
      validateSelect(tokens, i, end, nesting + 1);
      return;
    }
    invalid();
  }
  if (i >= end || !word('SELECT')) invalid();
}

export function validateReadSql(sql: string, params?: unknown[], mode?: SqlMode): void {
  const tokens = tokenizeSql(sql, mode);
  const first = tokens[0];
  if (
    first.kind !== 'word' ||
    !['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].includes(first.value)
  ) {
    throw new Error('Only read-only queries are permitted (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN).');
  }
  if (first.value === 'WITH') validateSelect(tokens, 0, tokens.length);
  const words = tokens.filter((t) => t.kind === 'word').map((t) => t.value);
  if (words.includes('INTO') || (first.value === 'EXPLAIN' && words.includes('ANALYZE'))) {
    throw new Error('File output, SELECT INTO, and EXPLAIN ANALYZE are not permitted.');
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!['word', 'quoted'].includes(token.kind)) continue;
    const functionName =
      token.kind === 'quoted' ? token.value.slice(1, -1).toUpperCase() : token.value;
    if (token.value === 'FOR' && ['UPDATE', 'SHARE'].includes(tokens[i + 1]?.value)) {
      throw new Error('Locking reads are not permitted.');
    }
    if (token.value === 'LOCK' && tokens[i + 1]?.value === 'IN') {
      throw new Error('Locking reads are not permitted.');
    }
    if (
      [
        'GET_LOCK',
        'RELEASE_LOCK',
        'RELEASE_ALL_LOCKS',
        'SERVICE_GET_READ_LOCKS',
        'SERVICE_GET_WRITE_LOCKS',
        'SERVICE_RELEASE_LOCKS',
      ].includes(functionName) &&
      tokens[i + 1]?.value === '('
    ) {
      throw new Error('Advisory lock functions are not permitted.');
    }
  }
  validateParameters(tokens, params);
}

/** Restrict write predicates to column comparisons with bound values, joined by AND/OR. */
function validateWritePredicate(tokens: Token[]): void {
  let i = 0;
  const invalid = () => {
    throw new Error('WHERE requires column comparisons to bound values, joined by AND/OR.');
  };
  const identifier = () => {
    const token = tokens[i];
    if (
      !token ||
      !(
        token.kind === 'quoted' ||
        (token.kind === 'word' &&
          /^[A-Z_$]/.test(token.value) &&
          !['TRUE', 'FALSE', 'NULL'].includes(token.value))
      )
    )
      invalid();
    i++;
    if (tokens[i]?.value === '.') {
      i++;
      const column = tokens[i];
      if (
        !column ||
        !(column.kind === 'quoted' || (column.kind === 'word' && /^[A-Z_$]/.test(column.value)))
      )
        invalid();
      i++;
    }
  };
  const parameter = () => {
    if (tokens[i++]?.kind !== 'parameter') invalid();
  };
  const predicate = (): void => {
    if (tokens[i]?.value === '(') {
      i++;
      expression();
      if (tokens[i++]?.value !== ')') invalid();
      return;
    }
    identifier();
    const operator = tokens[i++]?.value;
    if (operator === 'IN') {
      if (tokens[i++]?.value !== '(') invalid();
      parameter();
      while (tokens[i]?.value === ',') {
        i++;
        parameter();
      }
      if (tokens[i++]?.value !== ')') invalid();
    } else if (operator === 'BETWEEN') {
      parameter();
      if (tokens[i++]?.value !== 'AND') invalid();
      parameter();
    } else {
      let comparison = operator ?? '';
      while (tokens[i]?.kind === 'symbol' && ['=', '<', '>'].includes(tokens[i].value))
        comparison += tokens[i++].value;
      if (!['=', '<', '>', '<=', '>=', '<>', '!=', '<=>', 'LIKE'].includes(comparison)) invalid();
      parameter();
    }
  };
  const expression = (): void => {
    predicate();
    while (['AND', 'OR'].includes(tokens[i]?.value)) {
      i++;
      predicate();
    }
  };
  expression();
  if (i !== tokens.length) invalid();
}

export function validateWriteSql(sql: string, params?: unknown[], mode?: SqlMode): void {
  const tokens = tokenizeSql(sql, mode);
  const first = tokens[0];
  if (first.kind !== 'word' || !['INSERT', 'UPDATE', 'DELETE'].includes(first.value)) {
    throw new Error(
      'Only INSERT, UPDATE, and DELETE are permitted. Schema operations are blocked.',
    );
  }
  if (tokens.some((t) => t.kind === 'word' && t.value === 'SELECT')) {
    throw new Error('Subqueries (SELECT) are not allowed in write operations.');
  }
  if (first.value !== 'INSERT') {
    const where = tokens.findIndex(
      (t) => t.kind === 'word' && t.value === 'WHERE' && t.depth === 0,
    );
    const boundary = tokens.findIndex(
      (t, i) =>
        i > where &&
        t.kind === 'word' &&
        t.depth === 0 &&
        ['ORDER', 'LIMIT', 'RETURNING'].includes(t.value),
    );
    const predicate = tokens.slice(where + 1, boundary < 0 ? undefined : boundary);
    if (where < 0 || !predicate.some((t) => t.kind === 'parameter')) {
      throw new Error(`${first.value} requires a parameterized WHERE clause.`);
    }
    validateWritePredicate(predicate);
  }
  validateParameters(tokens, params);
}
