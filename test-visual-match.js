const assert = require('assert');
require('dotenv').config();
const { parseVisualMatches } = require('./aiService');

const candidateIds = ['product-a', 'product-b'];
assert.deepStrictEqual(
    parseVisualMatches('{"matches":[{"id":"product-a","confidence":0.91},{"id":"product-b","confidence":0.62}]}', candidateIds),
    [{ id: 'product-a', confidence: 0.91 }]
);
assert.deepStrictEqual(parseVisualMatches('```json\n{"matches":[{"id":"unknown","confidence":0.99}]}\n```', candidateIds), []);
assert.deepStrictEqual(parseVisualMatches('not json', candidateIds), []);
assert.deepStrictEqual(parseVisualMatches('{invalid json}', candidateIds), []);
console.log('Visual-match response parsing passed.');
