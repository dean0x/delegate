import { withServices } from '../services.js';
import * as ui from '../ui.js';

export async function handlePipelineCommand(pipelineArgs: string[]) {
  // Each positional arg is a pipeline step prompt
  const steps = pipelineArgs.filter((arg) => !arg.startsWith('-'));

  if (steps.length < 2) {
    ui.error('Pipeline requires at least 2 steps');
    process.stderr.write('Usage: beat pipeline <prompt> <prompt> [<prompt>]...\n');
    process.stderr.write('Example: beat pipeline "setup db" "run migrations" "seed data"\n');
    process.exit(1);
  }

  const s = ui.createSpinner();
  s.start(`Creating pipeline with ${steps.length} steps...`);

  const { scheduleService } = await withServices(s);

  const result = await scheduleService.createPipeline({
    steps: steps.map((prompt) => ({ prompt })),
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
