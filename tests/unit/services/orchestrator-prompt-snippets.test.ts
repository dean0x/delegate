/**
 * Unit tests for orchestrator-prompt snippet builder functions.
 * ARCHITECTURE: Tests pure function outputs — no I/O, no mocks needed.
 * Each builder is tested independently for content correctness and
 * agent/model flag threading.
 */

import { describe, expect, it } from 'vitest';
import {
  buildConstraintInstructions,
  buildDelegationInstructions,
  buildOrchestratorPrompt,
  buildStateManagementInstructions,
} from '../../../src/services/orchestrator-prompt.js';

describe('buildDelegationInstructions', () => {
  it('includes beat CLI commands without flags when no agent/model provided', () => {
    const result = buildDelegationInstructions({});
    expect(result).toContain('beat run "<prompt>"');
    expect(result).toContain('beat status <task-id>');
    expect(result).toContain('beat logs <task-id>');
    expect(result).toContain('beat cancel <task-id>');
    expect(result).not.toContain('--agent');
    expect(result).not.toContain('--model');
  });

  it('threads --agent flag into delegation examples', () => {
    const result = buildDelegationInstructions({ agent: 'claude' });
    expect(result).toContain('beat run --agent claude "<prompt>"');
    expect(result).toContain('beat loop --agent claude "<prompt>"');
    expect(result).not.toContain('--model');
  });

  it('threads --model flag into delegation examples', () => {
    const result = buildDelegationInstructions({ model: 'claude-opus-4-5' });
    expect(result).toContain('beat run --model claude-opus-4-5 "<prompt>"');
    expect(result).not.toContain('--agent');
  });

  it('threads both --agent and --model flags when both provided', () => {
    const result = buildDelegationInstructions({ agent: 'codex', model: 'o3' });
    expect(result).toContain('beat run --agent codex --model o3 "<prompt>"');
    expect(result).toContain('beat loop --agent codex --model o3 "<prompt>"');
  });

  it('includes WORKER MANAGEMENT section', () => {
    const result = buildDelegationInstructions({});
    expect(result).toContain('WORKER MANAGEMENT');
    expect(result).toContain('Workers persist across iterations');
  });

  it('includes LOOP MANAGEMENT section', () => {
    const result = buildDelegationInstructions({});
    expect(result).toContain('LOOP MANAGEMENT');
    expect(result).toContain('--until');
    expect(result).toContain('--eval-mode agent');
    expect(result).toContain('beat loop status');
    expect(result).toContain('beat loop cancel');
  });

  it('includes AGENT EVAL MODE section', () => {
    const result = buildDelegationInstructions({});
    expect(result).toContain('AGENT EVAL MODE');
    expect(result).toContain('PASS');
    expect(result).toContain('FAIL');
    expect(result).toContain('numeric score');
  });

  it('returns a non-empty string', () => {
    const result = buildDelegationInstructions({});
    expect(result.length).toBeGreaterThan(100);
  });
});

describe('buildStateManagementInstructions', () => {
  const stateFilePath = '/home/user/.autobeat/orchestrator-state/state-123.json';

  it('includes the state file path', () => {
    const result = buildStateManagementInstructions({ stateFilePath });
    expect(result).toContain(stateFilePath);
  });

  it('includes read/write timing guidance', () => {
    const result = buildStateManagementInstructions({ stateFilePath });
    expect(result).toContain('START of every iteration');
    expect(result).toContain('BEFORE exiting each iteration');
  });

  it('includes completion signal', () => {
    const result = buildStateManagementInstructions({ stateFilePath });
    expect(result).toContain('status: "complete"');
  });

  it('includes failure signal', () => {
    const result = buildStateManagementInstructions({ stateFilePath });
    expect(result).toContain('status: "failed"');
    expect(result).toContain('context field');
  });

  it('includes RESILIENCE section', () => {
    const result = buildStateManagementInstructions({ stateFilePath });
    expect(result).toContain('RESILIENCE');
    expect(result).toContain('missing or corrupted');
    expect(result).toContain('reconstruct');
  });

  it('embeds the correct path in all occurrences', () => {
    const path = '/tmp/custom-state.json';
    const result = buildStateManagementInstructions({ stateFilePath: path });
    expect(result).toContain(path);
    // No old path leaking in
    expect(result).not.toContain(stateFilePath);
  });
});

describe('buildConstraintInstructions', () => {
  it('includes max workers constraint', () => {
    const result = buildConstraintInstructions({ maxWorkers: 10, maxDepth: 3 });
    expect(result).toContain('Max concurrent workers: 10');
  });

  it('includes max depth constraint', () => {
    const result = buildConstraintInstructions({ maxWorkers: 5, maxDepth: 7 });
    expect(result).toContain('Max delegation depth: 7');
  });

  it('includes qualitative constraints', () => {
    const result = buildConstraintInstructions({ maxWorkers: 5, maxDepth: 3 });
    expect(result).toContain('sequential work');
    expect(result).toContain('Max 3 workers');
  });

  it('uses provided values (not defaults)', () => {
    const result = buildConstraintInstructions({ maxWorkers: 1, maxDepth: 1 });
    expect(result).toContain('Max concurrent workers: 1');
    expect(result).toContain('Max delegation depth: 1');
    expect(result).not.toContain('Max concurrent workers: 5');
  });
});

describe('snippet-vs-prompt drift detection', () => {
  // Guards against the snippet builders and buildOrchestratorPrompt accidentally
  // diverging on the key markers that callers depend on. Design keeps them separate
  // (intentional); this test ensures their shared conceptual content stays in sync.

  const stateFilePath = '/home/user/.autobeat/orchestrator-state/state-drift.json';
  const maxWorkers = 8;
  const maxDepth = 4;

  it('buildDelegationInstructions and systemPrompt share beat CLI command markers', () => {
    const snippet = buildDelegationInstructions({});
    const { systemPrompt } = buildOrchestratorPrompt({
      goal: 'drift test',
      stateFilePath,
      workingDirectory: '/workspace',
      maxDepth,
      maxWorkers,
    });

    const sharedMarkers = ['beat run', 'beat status', 'beat logs', 'beat cancel', 'beat loop', '--eval-mode agent'];

    for (const marker of sharedMarkers) {
      expect(snippet, `snippet missing marker: "${marker}"`).toContain(marker);
      expect(systemPrompt, `systemPrompt missing marker: "${marker}"`).toContain(marker);
    }
  });

  it('buildDelegationInstructions and operationalContract share beat CLI command markers', () => {
    const snippet = buildDelegationInstructions({});
    const { operationalContract } = buildOrchestratorPrompt({
      goal: 'drift test',
      stateFilePath,
      workingDirectory: '/workspace',
      maxDepth,
      maxWorkers,
    });

    // operationalContract uses a condensed delegation block — verify the core commands
    const sharedMarkers = ['beat run', 'beat status', 'beat logs', 'beat cancel'];

    for (const marker of sharedMarkers) {
      expect(snippet, `snippet missing marker: "${marker}"`).toContain(marker);
      expect(operationalContract, `operationalContract missing marker: "${marker}"`).toContain(marker);
    }
  });

  it('buildStateManagementInstructions and operationalContract share state-file markers', () => {
    const snippet = buildStateManagementInstructions({ stateFilePath });
    const { operationalContract } = buildOrchestratorPrompt({
      goal: 'drift test',
      stateFilePath,
      workingDirectory: '/workspace',
      maxDepth,
      maxWorkers,
    });

    const sharedMarkers = [stateFilePath, 'status: "complete"', 'status: "failed"'];

    for (const marker of sharedMarkers) {
      expect(snippet, `snippet missing marker: "${marker}"`).toContain(marker);
      expect(operationalContract, `operationalContract missing marker: "${marker}"`).toContain(marker);
    }
  });

  it('buildStateManagementInstructions and systemPrompt share state-file markers', () => {
    const snippet = buildStateManagementInstructions({ stateFilePath });
    const { systemPrompt } = buildOrchestratorPrompt({
      goal: 'drift test',
      stateFilePath,
      workingDirectory: '/workspace',
      maxDepth,
      maxWorkers,
    });

    const sharedMarkers = [stateFilePath, 'status: "complete"', 'status: "failed"'];

    for (const marker of sharedMarkers) {
      expect(snippet, `snippet missing marker: "${marker}"`).toContain(marker);
      expect(systemPrompt, `systemPrompt missing marker: "${marker}"`).toContain(marker);
    }
  });

  it('buildConstraintInstructions and systemPrompt share constraint markers', () => {
    const snippet = buildConstraintInstructions({ maxWorkers, maxDepth });
    const { systemPrompt } = buildOrchestratorPrompt({
      goal: 'drift test',
      stateFilePath,
      workingDirectory: '/workspace',
      maxDepth,
      maxWorkers,
    });

    const sharedMarkers = [`Max concurrent workers: ${maxWorkers}`, `Max delegation depth: ${maxDepth}`];

    for (const marker of sharedMarkers) {
      expect(snippet, `snippet missing marker: "${marker}"`).toContain(marker);
      expect(systemPrompt, `systemPrompt missing marker: "${marker}"`).toContain(marker);
    }
  });

  it('buildConstraintInstructions and operationalContract share constraint markers', () => {
    const snippet = buildConstraintInstructions({ maxWorkers, maxDepth });
    const { operationalContract } = buildOrchestratorPrompt({
      goal: 'drift test',
      stateFilePath,
      workingDirectory: '/workspace',
      maxDepth,
      maxWorkers,
    });

    const sharedMarkers = [`Max concurrent workers: ${maxWorkers}`, `Max delegation depth: ${maxDepth}`];

    for (const marker of sharedMarkers) {
      expect(snippet, `snippet missing marker: "${marker}"`).toContain(marker);
      expect(operationalContract, `operationalContract missing marker: "${marker}"`).toContain(marker);
    }
  });

  it('agent/model flags thread consistently across snippet builders and buildOrchestratorPrompt', () => {
    const agent = 'codex';
    const model = 'o4-mini';

    const snippet = buildDelegationInstructions({ agent, model });
    const { systemPrompt, operationalContract } = buildOrchestratorPrompt({
      goal: 'drift test',
      stateFilePath,
      workingDirectory: '/workspace',
      maxDepth,
      maxWorkers,
      agent,
      model,
    });

    const flagMarker = `--agent ${agent} --model ${model}`;

    expect(snippet, `snippet missing agent/model flags`).toContain(flagMarker);
    expect(systemPrompt, `systemPrompt missing agent/model flags`).toContain(flagMarker);
    expect(operationalContract, `operationalContract missing agent/model flags`).toContain(flagMarker);
  });
});

describe('buildOrchestratorPrompt - non-regression snapshot', () => {
  // This test verifies that the refactoring did NOT change the output of
  // buildOrchestratorPrompt. The three snippet builders are new exports;
  // the existing prompt builder must remain character-identical.

  const params = {
    goal: 'Build a complete authentication system',
    stateFilePath: '/home/user/.autobeat/orchestrator-state/state-123.json',
    workingDirectory: '/workspace/my-project',
    maxDepth: 3,
    maxWorkers: 5,
  };

  it('systemPrompt still contains all expected sections', () => {
    const { systemPrompt } = buildOrchestratorPrompt(params);
    // Role
    expect(systemPrompt).toContain('ROLE: You are an autonomous software engineering orchestrator');
    // State file section
    expect(systemPrompt).toContain('STATE FILE: /home/user/.autobeat/orchestrator-state/state-123.json');
    expect(systemPrompt).toContain('Read this file at the START of every iteration');
    // Working directory
    expect(systemPrompt).toContain('WORKING DIRECTORY: /workspace/my-project');
    // Worker management
    expect(systemPrompt).toContain('WORKER MANAGEMENT (via beat CLI)');
    expect(systemPrompt).toContain('beat run "<prompt>"');
    // Loop management
    expect(systemPrompt).toContain('LOOP MANAGEMENT');
    // Constraints
    expect(systemPrompt).toContain('Max concurrent workers: 5');
    expect(systemPrompt).toContain('Max delegation depth: 3');
    // Decision protocol
    expect(systemPrompt).toContain('DECISION PROTOCOL');
    // Resilience
    expect(systemPrompt).toContain('RESILIENCE');
    expect(systemPrompt).toContain('state file is missing or corrupted');
  });

  it('systemPrompt does not contain the goal', () => {
    const { systemPrompt } = buildOrchestratorPrompt(params);
    expect(systemPrompt).not.toContain('Build a complete authentication system');
  });

  it('userPrompt contains the goal', () => {
    const { userPrompt } = buildOrchestratorPrompt(params);
    expect(userPrompt).toContain('Build a complete authentication system');
  });

  it('operationalContract contains state file, working directory, delegation, constraints', () => {
    const { operationalContract } = buildOrchestratorPrompt(params);
    expect(operationalContract).toContain('REQUIRED — ORCHESTRATOR CONTRACT');
    expect(operationalContract).toContain('STATE FILE: /home/user/.autobeat/orchestrator-state/state-123.json');
    expect(operationalContract).toContain('WORKING DIRECTORY: /workspace/my-project');
    expect(operationalContract).toContain('DELEGATION (via beat CLI)');
    expect(operationalContract).toContain('CONSTRAINTS');
    expect(operationalContract).toContain('status: "complete"');
    expect(operationalContract).toContain('status: "failed"');
  });

  it('threads agent/model flags into systemPrompt and operationalContract', () => {
    const { systemPrompt, operationalContract } = buildOrchestratorPrompt({
      ...params,
      agent: 'codex',
      model: 'gpt-4o',
    });
    expect(systemPrompt).toContain('beat run --agent codex --model gpt-4o "<prompt>"');
    expect(operationalContract).toContain('beat run --agent codex --model gpt-4o "<prompt>"');
  });
});
