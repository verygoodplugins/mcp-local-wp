import { test } from 'vitest';
import assert from 'node:assert/strict';
import { validateReadSql, validateWriteSql } from '../src/sql-policy.js';

for (const sql of [
  'WITH t AS (SELECT 1) SELECT * FROM t',
  'WITH t (a, b) AS (SELECT ?, ?), u AS (SELECT a FROM t) SELECT * FROM u;',
  'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<3) SELECT * FROM t',
  '/* start */ WITH `t` AS (/* body */ SELECT 1) /* end */ SELECT * FROM `t`',
  "WITH t AS (SELECT '); UPDATE; /*!' AS value) SELECT * FROM t",
  'WITH t AS (WITH u AS (SELECT 1) SELECT * FROM u) SELECT * FROM t',
  'WITH t AS ((SELECT 1)) SELECT * FROM t',
  'WITH t AS (SELECT 1) (SELECT * FROM t)',
  'WITH t AS ((SELECT 1) UNION ALL (SELECT 2)) (SELECT * FROM t) ORDER BY 1 LIMIT 2',
]) {
  test(`accepts CTE read: ${sql}`, () => validateReadSql(sql, sql.includes('?') ? [1, 2] : []));
}
for (const sql of [
  'WITH t AS (SELECT 1) UPDATE wp_users SET user_pass=1',
  'WITH t AS (SELECT 1) DELETE FROM wp_users',
  'WITH t AS (SELECT 1) INSERT INTO wp_users VALUES (1)',
  'WITH t AS (UPDATE wp_users SET ID=1) SELECT * FROM t',
  'WITH t AS ((UPDATE wp_users SET ID=1)) SELECT * FROM t',
  'WITH t AS (SELECT 1) (DELETE FROM wp_users)',
  'WITH t AS ((SELECT 1) UPDATE wp_users SET ID=1) SELECT * FROM t',
  'WITH t AS (WITH u AS (SELECT 1) DELETE FROM wp_users) SELECT * FROM t',
  'WITH t AS () SELECT * FROM t',
  'WITH t AS (SELECT 1)',
  'WITH t AS (SELECT 1), SELECT 1',
  'WITH t AS (SELECT 1) u AS (SELECT 1) SELECT 1',
  'WITH t(a,) AS (SELECT 1) SELECT * FROM t',
  'WITH t AS SELECT 1 SELECT * FROM t',
  'WITH t AS (SELECT 1) SELECT * FROM t; DELETE FROM wp_users',
  "WITH t AS (SELECT 1 INTO OUTFILE '/tmp/blocked') SELECT * FROM t",
  "WITH t AS (SELECT 1) SELECT * FROM t INTO DUMPFILE '/tmp/blocked'",
  'WITH t AS (SELECT * FROM wp_users FOR UPDATE) SELECT * FROM t',
  'WITH t AS (SELECT 1) SELECT * FROM wp_users LOCK IN SHARE MODE',
  "WITH t AS (SELECT GET_LOCK('blocked', 0)) SELECT * FROM t",
  'WITH t AS (SELECT /*!80000 1 */ 1) SELECT * FROM t',
  'WITH t AS (SELECT 1) /*M! DELETE FROM wp_users */ SELECT * FROM t',
]) {
  test(`rejects unsafe or malformed CTE: ${sql}`, () => assert.throws(() => validateReadSql(sql)));
}
test('CTE placeholders and SQL modes use the shared tokenizer', () => {
  assert.throws(() => validateReadSql('WITH t AS (SELECT ?) SELECT * FROM t', []));
  validateReadSql('WITH "t"("v") AS (SELECT ?) SELECT "v" FROM "t"', [1], { ansiQuotes: true });
  validateReadSql("WITH t AS (SELECT 'x\\' AS v) SELECT * FROM t", [], {
    noBackslashEscapes: true,
  });
  assert.throws(() => validateReadSql("WITH t AS (SELECT 'x\\' AS v) SELECT * FROM t"));
  const nested = 'WITH t AS ('.repeat(66) + 'SELECT 1' + ') SELECT * FROM t'.repeat(66);
  assert.throws(() => validateReadSql(nested), /WITH requires/);
});

for (const sql of [
  'SELECT 1',
  ' select ? ; -- tail\n',
  '/* normal */ /* second */ SELECT 1',
  '# leading\nSELECT 1',
  '-- leading\nSHOW TABLES',
  'DESCRIBE wp_users',
  'DESC wp_users',
  'EXPLAIN SELECT 1',
  "SELECT '; INTO /*! UPDATE'",
  'SELECT `INTO` FROM wp_users',
  "SELECT 'it''s; fine'",
  "SELECT 'it\\'s; fine'",
]) {
  test(`accepts read: ${sql}`, () => validateReadSql(sql, sql.includes('?') ? [1] : undefined));
}
for (const sql of [
  '',
  '/* only */',
  'UPDATE wp_users SET user_pass=?',
  "/*! UPDATE wp_users SET user_pass=( */ SELECT 'marker' /*! ) WHERE ID=1 */",
  '/*M!100100 UPDATE wp_users SET user_pass=( */ SELECT 1 /*M! ) */',
  'SELECT /*!80000 + 1 */ 1',
  'SELECT /*M! + 1 */ 1',
  'SELECT /*+ SET_VAR(sort_buffer_size=16M) */ 1',
  'SELECT 1; UPDATE wp_users SET user_pass=1',
  'SELECT 1;;',
  ';SELECT 1',
  "SELECT 'unterminated",
  'SELECT /* unterminated',
  'SELECT /* nested /* */ 1',
  'SELECT (1',
  'SELECT 1)',
  'SELECT 1 INTO OUTFILE "/tmp/file"',
  'SELECT 1 INTO DUMPFILE "/tmp/file"',
  'SELECT 1 INTO @x',
  'SELECT 1 # hidden\r INTO OUTFILE "/tmp/file"',
  'SELECT `GET_LOCK`("x",0)',
  'EXPLAIN ANALYZE SELECT 1',
  'SELECT 1 FOR UPDATE',
  'SELECT 1 FOR SHARE',
  'SELECT 1 LOCK IN SHARE MODE',
  "SELECT GET_LOCK('x',0)",
  "SELECT RELEASE_LOCK('x')",
  'SELECT RELEASE_ALL_LOCKS()',
  'SELECT service_get_write_locks("namespace","name",60)',
  'SELECT SERVICE_GET_READ_LOCKS("namespace","name",60)',
  'SELECT service_release_locks("namespace")',
]) {
  test(`rejects unsafe read: ${sql}`, () => assert.throws(() => validateReadSql(sql)));
}
test('uses session SQL modes for string boundaries', () => {
  assert.throws(() =>
    validateReadSql("SELECT 'x\\'; SELECT 2'", undefined, { noBackslashEscapes: true }),
  );
  validateReadSql("SELECT 'x\\'; SELECT 2'");
  validateReadSql('SELECT "quoted""identifier"', undefined, { ansiQuotes: true });
});
test('parameter count ignores quoted placeholders', () => {
  validateReadSql("SELECT '?', ?", [1]);
  assert.throws(() => validateReadSql('SELECT ?', []));
  assert.throws(() => validateReadSql('SELECT 1', [1]));
});
test('writes require placeholders in an actual WHERE predicate', () => {
  validateWriteSql('UPDATE wp_users SET user_pass=? WHERE ID=?', ['hash', 1]);
  validateWriteSql('DELETE FROM wp_users WHERE ID=?', [1]);
  validateWriteSql('INSERT INTO wp_users (ID) VALUES (?)', [1]);
  for (const [sql, params] of [
    ['UPDATE wp_users SET user_pass=?', ['hash']],
    ['UPDATE wp_users SET user_pass=? WHERE ID=1', ['hash']],
    ['DELETE FROM wp_users WHERE ID=1 LIMIT ?', [1]],
    ["UPDATE wp_users SET user_pass='WHERE ?'", []],
    ['UPDATE wp_users SET ID=? /* WHERE ID=? */', [1]],
    ['UPDATE wp_users SET ID=(SELECT ?)', [1]],
    ['DROP TABLE wp_users', []],
    ['/*! DROP TABLE wp_users */ INSERT INTO wp_users VALUES (?)', [1]],
  ] as [string, unknown[]][])
    assert.throws(() => validateWriteSql(sql, params));
});

test('writes reject placeholder-only and constant tautological predicates', () => {
  for (const sql of [
    'DELETE FROM wp_users WHERE ?',
    'DELETE FROM wp_users WHERE 1=?',
    'DELETE FROM wp_users WHERE ID >> ?',
    'UPDATE wp_users SET ID=2 WHERE ID=? OR 1',
    'DELETE FROM wp_users WHERE ID=? OR ?',
  ]) {
    assert.throws(() =>
      validateWriteSql(
        sql,
        sql.match(/\?/g)?.map(() => 1),
      ),
    );
  }
  validateWriteSql(
    'DELETE FROM wp_users WHERE (ID=? OR ID IN (?,?)) AND ID BETWEEN ? AND ?',
    [1, 2, 3, 4, 5],
  );
});
