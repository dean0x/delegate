/**
 * Unit tests for keyboard/hints.ts pure functions.
 * ARCHITECTURE: These are pure functions — no I/O, no side effects.
 * Tests assert on returned hint strings for all branching conditions.
 */

import { describe, expect, it } from 'vitest';
import { detailHints, getHints, mainHints } from '../../../../src/cli/dashboard/keyboard/hints';

describe('mainHints()', () => {
  it('returns base hint string when hasMutations is false', () => {
    const result = mainHints(false);
    expect(result).toContain('Tab: panel');
    expect(result).toContain('1-5: panel');
    expect(result).toContain('↑↓: select');
    expect(result).toContain('Enter: detail');
    expect(result).toContain('r refresh');
    expect(result).toContain('q quit');
  });

  it('does NOT include mutation hints when hasMutations is false', () => {
    const result = mainHints(false);
    expect(result).not.toContain('c cancel');
    expect(result).not.toContain('d delete');
    expect(result).not.toContain('p pause/resume');
  });

  it('includes c cancel and d delete when hasMutations is true', () => {
    const result = mainHints(true);
    expect(result).toContain('c cancel');
    expect(result).toContain('d delete (terminal)');
  });

  it('does NOT include p pause/resume when hasMutations is true and focusedPanel is undefined', () => {
    const result = mainHints(true);
    expect(result).not.toContain('p pause/resume');
  });

  it('includes p pause/resume when hasMutations is true and focusedPanel is schedules', () => {
    const result = mainHints(true, 'schedules');
    expect(result).toContain('p pause/resume');
  });

  it('includes p pause/resume when hasMutations is true and focusedPanel is loops', () => {
    const result = mainHints(true, 'loops');
    expect(result).toContain('p pause/resume');
  });

  it('does NOT include p pause/resume when hasMutations is true and focusedPanel is tasks', () => {
    const result = mainHints(true, 'tasks');
    expect(result).not.toContain('p pause/resume');
  });

  it('does NOT include p pause/resume when hasMutations is true and focusedPanel is orchestrations', () => {
    const result = mainHints(true, 'orchestrations');
    expect(result).not.toContain('p pause/resume');
  });

  it('does NOT include p pause/resume when hasMutations is true and focusedPanel is pipelines', () => {
    const result = mainHints(true, 'pipelines');
    expect(result).not.toContain('p pause/resume');
  });
});

describe('detailHints()', () => {
  it('returns base hint string when called with no arguments', () => {
    const result = detailHints();
    expect(result).toContain('Esc back');
    expect(result).toContain('↑↓ select');
    expect(result).toContain('r refresh');
    expect(result).toContain('q quit');
  });

  it('does NOT include p pause or p resume when called with no arguments', () => {
    const result = detailHints();
    expect(result).not.toContain('p pause');
    expect(result).not.toContain('p resume');
  });

  it('appends p pause for active schedule', () => {
    const result = detailHints('schedules', 'active');
    expect(result).toContain('p pause');
    expect(result).not.toContain('p resume');
  });

  it('appends p resume for paused schedule', () => {
    const result = detailHints('schedules', 'paused');
    expect(result).toContain('p resume');
    expect(result).not.toContain('p pause');
  });

  it('appends p pause for running loop', () => {
    const result = detailHints('loops', 'running');
    expect(result).toContain('p pause');
    expect(result).not.toContain('p resume');
  });

  it('appends p resume for paused loop', () => {
    const result = detailHints('loops', 'paused');
    expect(result).toContain('p resume');
    expect(result).not.toContain('p pause');
  });

  it('does NOT include p pause or p resume for tasks with running status', () => {
    const result = detailHints('tasks', 'running');
    expect(result).not.toContain('p pause');
    expect(result).not.toContain('p resume');
  });

  it('does NOT include p pause or p resume for schedules with an unknown status', () => {
    const result = detailHints('schedules', 'pending');
    expect(result).not.toContain('p pause');
    expect(result).not.toContain('p resume');
  });
});

describe('getHints()', () => {
  it('delegates to mainHints when viewKind is main with mutations and schedules panel', () => {
    const result = getHints('main', true, undefined, undefined, 'schedules');
    expect(result).toContain('p pause/resume');
    expect(result).toContain('c cancel');
    expect(result).toContain('Tab: panel');
  });

  it('delegates to mainHints when viewKind is main without mutations', () => {
    const result = getHints('main', false);
    expect(result).not.toContain('c cancel');
    expect(result).not.toContain('p pause/resume');
    expect(result).toContain('Tab: panel');
  });

  it('delegates to detailHints when viewKind is detail for active schedule', () => {
    const result = getHints('detail', false, 'schedules', 'active');
    expect(result).toContain('p pause');
    expect(result).toContain('Esc back');
  });

  it('delegates to detailHints when viewKind is detail for paused loop', () => {
    const result = getHints('detail', false, 'loops', 'paused');
    expect(result).toContain('p resume');
    expect(result).toContain('Esc back');
  });

  it('ignores hasMutations when viewKind is detail', () => {
    // Detail view does not use hasMutations — its hints are driven by entityType/entityStatus
    const withMutations = getHints('detail', true, 'tasks', 'running');
    const withoutMutations = getHints('detail', false, 'tasks', 'running');
    expect(withMutations).toEqual(withoutMutations);
  });
});
