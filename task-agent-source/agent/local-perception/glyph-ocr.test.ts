import assert from 'node:assert/strict';import test from 'node:test';
import {parseGlyphTsv,mergeGlyphs} from './glyph-ocr';
test('supplemental OCR keeps original scores and rejects invented letters, invalid geometry and weak symbols',()=>{
  const tsv='header\n'+['5\t1\t1\t1\t1\t1\t500\t900\t30\t20\t93\t=','5\t1\t1\t1\t1\t1\t500\t400\t30\t20\t62\t0','5\t1\t1\t1\t1\t1\t500\t400\t30\t20\t98\tF','5\t1\t1\t1\t1\t1\t710\t400\t30\t20\t98\t9'].join('\n');
  const result=parseGlyphTsv(tsv,720,1280);assert.equal(result.length,1);assert.equal(result[0].text,'=');assert.equal(result[0].confidence,.93);
  const conflict={...result[0],text:'-'};assert.deepEqual(mergeGlyphs([conflict],result),[conflict]);
});
