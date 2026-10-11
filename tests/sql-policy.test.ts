import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReadSql, validateWriteSql } from '../src/sql-policy.js';

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
  'SELECT 1 # hidden\r INTO OUTFILE \"/tmp/file\"',
  'SELECT `GET_LOCK`(\"x\",0)',
  'EXPLAIN ANALYZE SELECT 1',
  'SELECT 1 FOR UPDATE',
  'SELECT 1 FOR SHARE',
  'SELECT 1 LOCK IN SHARE MODE',
  "SELECT GET_LOCK('x',0)",
  "SELECT RELEASE_LOCK('x')",
  'SELECT RELEASE_ALL_LOCKS()',
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
  for (const sql of ['DELETE FROM wp_users WHERE ?', 'DELETE FROM wp_users WHERE 1=?', 'UPDATE wp_users SET ID=2 WHERE ID=? OR 1', 'DELETE FROM wp_users WHERE ID=? OR ?']) {
    assert.throws(() => validateWriteSql(sql, sql.match(/\?/g)?.map(() => 1)));
  }
  validateWriteSql('DELETE FROM wp_users WHERE (ID=? OR ID IN (?,?)) AND ID BETWEEN ? AND ?', [1,2,3,4,5]);
});
