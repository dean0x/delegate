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
    expect(result).toContain('1-6: panel');
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

  it('includes p pause/resume when hasMutations is true and focusedPanel is channels', () => {
    const result = mainHints(true, 'channels');
    expect(result).toContain('p pause/resume');
  });

  it('does NOT include p pause/resume when hasMutations is false and focusedPanel is channels', () => {
    const result = mainHints(false, 'channels');
    expect(result).not.toContain('p pause/resume');
  });
});

describe('detailHints()', () => {
  it('returns base hint string with output controls when called with no arguments', () => {
    const result = detailHints();
    expect(result).toContain('Esc back');
    expect(result).toContain('↑↓ select');
    expect(result).toContain('o output');
    expect(result).toContain('[/] scroll');
    expect(result).toContain('G tail');
    expect(result).toContain('r refresh');
    expect(result).toContain('q quit');
  });

  it('does NOT include p pause or p resume when called with no arguments', () => {
    const result = detailHints();
    expect(result).not.toContain('p pause');
    expect(result).not.toContain('p resume');
  });

  it('includes output controls for tasks (output streaming applies)', () => {
    const result = detailHints('tasks', 'running');
    expect(result).toContain('o output');
    expect(result).toContain('[/] scroll');
    expect(result).toContain('G tail');
  });

  it('includes output controls for orchestrations (output streaming applies)', () => {
    const result = detailHints('orchestrations', 'running');
    expect(result).toContain('o output');
    expect(result).toContain('[/] scroll');
    expect(result).toContain('G tail');
  });

  it('omits output controls for schedules (output streaming does not apply)', () => {
    const result = detailHints('schedules', 'active');
    expect(result).not.toContain('o output');
    expect(result).not.toContain('[/] scroll');
    expect(result).not.toContain('G tail');
  });

  it('omits output controls for loops (output streaming does not apply)', () => {
    const result = detailHints('loops', 'running');
    expect(result).not.toContain('o output');
    expect(result).not.toContain('[/] scroll');
    expect(result).not.toContain('G tail');
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

  it('appends ↑↓ member and p pause for active channel', () => {
    const result = detailHints('channels', 'active');
    expect(result).toContain('↑↓ member');
    expect(result).toContain('p pause');
    expect(result).not.toContain('p resume');
  });

  it('appends ↑↓ member and p resume for paused channel', () => {
    const result = detailHints('channels', 'paused');
    expect(result).toContain('↑↓ member');
    expect(result).toContain('p resume');
    expect(result).not.toContain('p pause');
  });

  it('appends only ↑↓ member for channels with non-pausable status', () => {
    const result = detailHints('channels', 'completed');
    expect(result).toContain('↑↓ member');
    expect(result).not.toContain('p pause');
    expect(result).not.toContain('p resume');
  });

  it('omits output controls for channels (no output streaming)', () => {
    const result = detailHints('channels', 'active');
    expect(result).not.toContain('o output');
    expect(result).not.toContain('[/] scroll');
    expect(result).not.toContain('G tail');
  });
});

describe('getHints()', () => {
  it('routes to main hints by viewKind', () => {
    expect(getHints('main', false)).toContain('Tab: panel');
    expect(getHints('main', true)).toContain('c cancel');
  });

  it('routes to detail hints by viewKind', () => {
    expect(getHints('detail', true, 'schedules', 'active')).toContain('p pause');
    expect(getHints('detail', false)).toContain('Esc back');
  });

  it('suppresses pause/resume hints in read-only detail view', () => {
    expect(getHints('detail', false, 'schedules', 'active')).not.toContain('p pause');
    expect(getHints('detail', false, 'loops', 'running')).not.toContain('p pause');
    expect(getHints('detail', false, 'schedules', 'paused')).not.toContain('p resume');
  });
});
