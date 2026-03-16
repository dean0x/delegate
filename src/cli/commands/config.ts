import {
  CONFIG_FILE_PATH,
  ConfigurationSchema,
  loadConfiguration,
  resetConfigValue,
  saveConfigValue,
} from '../../core/configuration.js';
import * as ui from '../ui.js';

export function configShow() {
  const config = loadConfiguration();

  const lines: string[] = [];

  lines.push(ui.bold('Core Settings'));
  lines.push(`  timeout              ${ui.formatMs(config.timeout)} ${ui.dim(`(${config.timeout}ms)`)}`);
  lines.push(
    `  maxOutputBuffer      ${ui.formatBytes(config.maxOutputBuffer)} ${ui.dim(`(${config.maxOutputBuffer})`)}`,
  );
  lines.push(`  cpuCoresReserved     ${config.cpuCoresReserved} cores`);
  lines.push(`  memoryReserve        ${ui.formatBytes(config.memoryReserve)} ${ui.dim(`(${config.memoryReserve})`)}`);
  lines.push(`  logLevel             ${config.logLevel}`);
  lines.push('');
  lines.push(ui.bold('Process Management'));
  lines.push(
    `  killGracePeriodMs    ${ui.formatMs(config.killGracePeriodMs)} ${ui.dim(`(${config.killGracePeriodMs}ms)`)}`,
  );
  lines.push(
    `  resourceMonitorMs    ${ui.formatMs(config.resourceMonitorIntervalMs)} ${ui.dim(`(${config.resourceMonitorIntervalMs}ms)`)}`,
  );
  lines.push(
    `  minSpawnDelayMs      ${ui.formatMs(config.minSpawnDelayMs)} ${ui.dim(`(${config.minSpawnDelayMs}ms)`)}`,
  );
  lines.push(
    `  settlingWindowMs     ${ui.formatMs(config.settlingWindowMs)} ${ui.dim(`(${config.settlingWindowMs}ms)`)}`,
  );
  lines.push('');
  lines.push(ui.bold('Event System'));
  lines.push(`  maxListenersPerEvent   ${config.maxListenersPerEvent}`);
  lines.push(`  maxTotalSubscriptions  ${config.maxTotalSubscriptions}`);
  lines.push('');
  lines.push(ui.bold('Storage'));
  lines.push(
    `  fileStorageThreshold ${ui.formatBytes(config.fileStorageThresholdBytes)} ${ui.dim(`(${config.fileStorageThresholdBytes})`)}`,
  );
  lines.push('');
  lines.push(ui.bold('Retry'));
  lines.push(
    `  retryInitialDelayMs  ${ui.formatMs(config.retryInitialDelayMs)} ${ui.dim(`(${config.retryInitialDelayMs}ms)`)}`,
  );
  lines.push(
    `  retryMaxDelayMs      ${ui.formatMs(config.retryMaxDelayMs)} ${ui.dim(`(${config.retryMaxDelayMs}ms)`)}`,
  );
  lines.push('');
  lines.push(ui.bold('Recovery'));
  lines.push(`  taskRetentionDays    ${config.taskRetentionDays} days`);

  ui.note(lines.join('\n'), 'Configuration (env > config file > defaults)');
  ui.info(`Config file: ${CONFIG_FILE_PATH}`);
}

export function configSet(key: string | undefined, rawValue: string | undefined) {
  if (!key || rawValue === undefined) {
    ui.error('Usage: beat config set <key> <value>');
    process.stderr.write(`Valid keys: ${Object.keys(ConfigurationSchema.shape).join(', ')}\n`);
    process.exit(1);
  }

  // Parse value: numbers stay numbers, strings stay strings
  let value: unknown = rawValue;
  const asNum = Number(rawValue);
  if (!isNaN(asNum) && rawValue.trim() !== '') {
    value = asNum;
  }

  const result = saveConfigValue(key, value);
  if (!result.ok) {
    ui.error(String(result.error));
    process.exit(1);
  }

  // Show the resolved value after saving
  const config = loadConfiguration();
  const resolved = config[key as keyof typeof config];
  ui.success(`${key} = ${resolved}`);
}

export function configReset(key: string | undefined) {
  if (!key) {
    ui.error('Usage: beat config reset <key>');
    process.stderr.write(`Valid keys: ${Object.keys(ConfigurationSchema.shape).join(', ')}\n`);
    process.exit(1);
  }

  const result = resetConfigValue(key);
  if (!result.ok) {
    ui.error(String(result.error));
    process.exit(1);
  }

  const config = loadConfiguration();
  const resolved = config[key as keyof typeof config];
  ui.success(`${key} reset to default: ${resolved}`);
}

export function configPath() {
  ui.stdout(CONFIG_FILE_PATH);
}
