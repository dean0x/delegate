import { type AgentProvider, isAgentProvider } from '../../core/agents.js';
import { withServices } from '../services.js';
import * as ui from '../ui.js';

export async function handlePipelineCommand(pipelineArgs: string[]) {
  // Parse --agent flag before filtering positional args
  let agent: AgentProvider | undefined;
  const filteredArgs: string[] = [];

  for (let i = 0; i < pipelineArgs.length; i++) {
    const arg = pipelineArgs[i];
    const next = pipelineArgs[i + 1];

    if ((arg === '--agent' || arg === '-a') && next) {
      if (!isAgentProvider(next)) {
        ui.error(`Unknown agent: "${next}". Available agents: claude, codex, gemini`);
        process.exit(1);
      }
      agent = next;
      i++;
    } else if (arg.startsWith('-')) {
      ui.error(`Unknown flag: ${arg}`);
      process.exit(1);
    } else {
      filteredArgs.push(arg);
    }
  }

  // Each positional arg is a pipeline step prompt
  const steps = filteredArgs;

  if (steps.length < 2) {
    ui.error('Pipeline requires at least 2 steps');
    process.stderr.write('Usage: beat pipeline <prompt> <prompt> [<prompt>]... [--agent AGENT]\n');
    process.stderr.write('Example: beat pipeline "setup db" "run migrations" "seed data"\n');
    process.exit(1);
  }

  const s = ui.createSpinner();
  s.start(`Creating pipeline with ${steps.length} steps...`);

  const { scheduleService } = await withServices(s);

  const result = await scheduleService.createPipeline({
    steps: steps.map((prompt) => ({ prompt, agent })),
  });

  if (!result.ok) {
    s.stop('Pipeline creation failed');
    ui.error(result.error.message);
    process.exit(1);
  }

  s.stop('Pipeline created');

  // Show pipeline visualization
  const lines: string[] = [];
  for (let i = 0; i < result.value.steps.length; i++) {
    const step = result.value.steps[i];
    lines.push(`${i + 1}. ${ui.dim(`[${step.scheduleId}]`)} "${step.prompt}"`);
    if (i < result.value.steps.length - 1) {
      lines.push('   ↓');
    }
  }
  ui.note(lines.join('\n'), 'Pipeline Steps');

  process.exit(0);
}
