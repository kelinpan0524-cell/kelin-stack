import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeStateFrom, groupOf } from '../scripts/branches.mjs';

test('mergeStateFrom classifies the five states', () => {
  assert.equal(mergeStateFrom({ isAncestor: false, ownCommitCount: 0 }), 'no_own_commits');
  assert.equal(mergeStateFrom({ isAncestor: true, ownCommitCount: 3 }), 'merged');
  assert.equal(mergeStateFrom({ isAncestor: false, ownCommitCount: 3, squashMatch: true }), 'squash_merged');
  assert.equal(mergeStateFrom({ isAncestor: false, ownCommitCount: 3, cherryAllApplied: true }), 'rebase_merged');
  assert.equal(mergeStateFrom({ isAncestor: false, ownCommitCount: 3 }), 'unmerged');
  assert.equal(mergeStateFrom({ isAncestor: true, ownCommitCount: 0 }), 'no_own_commits');
});

test('groupOf sorts branches into the three groups', () => {
  assert.equal(groupOf('unmerged', ['local_only']), 'needs_decision');
  assert.equal(groupOf('unmerged', ['remote_deleted_unmerged']), 'needs_decision');
  assert.equal(groupOf('unmerged', ['uncommitted_changes']), 'in_progress');
  assert.equal(groupOf('unmerged', ['recent']), 'in_progress');
  assert.equal(groupOf('unmerged', []), 'needs_decision');
  assert.equal(groupOf('no_own_commits', []), 'needs_decision');
  assert.equal(groupOf('merged', []), 'cleanable');
  assert.equal(groupOf('squash_merged', []), 'cleanable');
  assert.equal(groupOf('rebase_merged', []), 'cleanable');
  assert.equal(groupOf('merged', ['uncommitted_changes']), 'in_progress');
});
