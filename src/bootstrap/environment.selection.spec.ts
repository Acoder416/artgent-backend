import { resolveEnvironment } from './environment';

describe('resolveEnvironment', () => {
  it('selects production from the start command before Nest modules load', () => {
    expect(resolveEnvironment(['--env=production'], {})).toBe('production');
  });
});
