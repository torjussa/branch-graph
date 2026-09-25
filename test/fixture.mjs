import { repoBuilder, tempDir } from '../src/demo.mjs';

export { tempDir };

/**
 * A small project with every case the flow checks know:
 * squash merges into development, merge promotions to test and main, a merge commit
 * into development, a commit without a PR, and a hotfix squashed straight onto main.
 */
export function createFixture(root = tempDir()) {
  const repo = repoBuilder(root, 'api')
    .commit('Initial commit')
    .checkout('development', 'main')
    .checkout('test', 'main')
    .checkout('development')
    .commit('Add login (#1)')
    .commit('Add search (#2)')
    .commit('wip')
    .checkout('test').merge('development', 'Merge pull request #3 from acme/development')
    .checkout('main').merge('test', 'Merge pull request #4 from acme/test')
    .checkout('development')
    .commit('Add export (#5)')
    .checkout('feature/chart', 'development').commit('Try new chart')
    .checkout('development').merge('feature/chart', 'Merge pull request #6 from acme/feature/chart')
    .checkout('main').commit('Hotfix typo (#7)')
    .checkout('test').merge('development', 'Merge pull request #8 from acme/development')
    .checkout('development').commit('Add settings page (#9)')
    .push(['development', 'test', 'main', 'feature/chart'], 'development');

  return {
    root,
    work: repo.work,
    remote: repo.remote,
    config: { name: 'Acme', days: 60, repos: [{ name: 'api', path: repo.work, branches: ['development', 'test', 'main'] }] },
  };
}
