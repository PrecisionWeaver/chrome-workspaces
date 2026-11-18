import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigEdit, ConfigEditValues } from '../../../shared/protocol/system';
import { errorMessage } from '../../../shared/protocol/errors';
import { MODEL_PATTERN } from '../../../shared/protocol/protocol';
import { COMMAND_NAME, DEFAULT_PROMPTS_FILE, expandHome, type HelperConfig, isDirectory, parseConfig } from './config';

/** The fields Settings edits, which a save applies to the running helper; everything else in the file is left as it was. */
const EDITABLE = ['defaultCwd', 'defaultModel', 'claudeCommand', 'promptsFile'] as const;
const PROMPTS_MAX_BYTES = 512 * 1024;

export type SaveResult = { ok: true; message: string } | { ok: false; message: string };

function readRaw(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} must hold a JSON object`);
  return parsed as Record<string, unknown>;
}

/** Writes beside the target and renames, so a crash leaves the old file whole; keeps the target's permissions. */
function writeAtomic(file: string, text: string): void {
  let mode: number | null = null;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // A new file takes the default mode.
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  if (mode !== null) chmodSync(tmp, mode);
  renameSync(tmp, file);
}

/** The editable fields as the file spells them, and the text of the prompts note the config names. */
export function readConfigEdit(file: string, config: HelperConfig): ConfigEdit {
  const raw = readRaw(file);
  const field = (key: (typeof EDITABLE)[number]) => (typeof raw[key] === 'string' ? raw[key] : '');
  let prompts: string | null = null;
  try {
    prompts = readFileSync(config.promptsFile, 'utf8');
  } catch {
    // The note does not exist yet; saving text creates it.
  }
  return {
    values: { defaultCwd: field('defaultCwd'), defaultModel: field('defaultModel'), claudeCommand: field('claudeCommand'), promptsFile: field('promptsFile') },
    promptsPath: config.promptsFile,
    prompts,
  };
}

/** What is wrong with `values`, one sentence each; nothing is written while any are. */
export function configEditProblems(values: ConfigEditValues, prompts: string | null): string[] {
  const problems: string[] = [];
  if (values.defaultCwd && !isDirectory(expandHome(values.defaultCwd))) problems.push(`Default directory ${values.defaultCwd} is not a folder.`);
  if (values.defaultModel && !MODEL_PATTERN.test(values.defaultModel)) problems.push(`Default model "${values.defaultModel}" is not a model name.`);
  if (values.claudeCommand && !COMMAND_NAME.test(values.claudeCommand))
    problems.push(`Command "${values.claudeCommand}" must be a bare command name, with no spaces or path.`);
  if (prompts !== null) {
    if (Buffer.byteLength(prompts) > PROMPTS_MAX_BYTES) problems.push('The prompts note is over 512 KB.');
    const folder = dirname(expandHome(values.promptsFile || DEFAULT_PROMPTS_FILE));
    if (!isDirectory(folder)) problems.push(`The prompts file's folder ${folder} does not exist.`);
  }
  return problems;
}

/**
 * Validates, then writes the four editable fields into config.json (an empty one is removed, so the default applies), writes the
 * prompts note if `prompts` is given, and applies the new values to `config` so the next workspace uses them.
 */
export function saveConfigEdit(file: string, config: HelperConfig, values: ConfigEditValues, prompts: string | null): SaveResult {
  const trimmed: ConfigEditValues = {
    defaultCwd: values.defaultCwd.trim(),
    defaultModel: values.defaultModel.trim(),
    claudeCommand: values.claudeCommand.trim(),
    promptsFile: values.promptsFile.trim(),
  };
  const problems = configEditProblems(trimmed, prompts);
  if (problems.length) return { ok: false, message: problems.join(' ') };
  try {
    const raw = readRaw(file);
    for (const key of EDITABLE) {
      if (trimmed[key]) raw[key] = trimmed[key];
      else delete raw[key];
    }
    const text = `${JSON.stringify(raw, null, 2)}\n`;
    // Parsed before it is written, so a value the helper would drop never reaches the file.
    const applied = parseConfig(text, file);
    writeAtomic(file, text);
    config.defaultCwd = applied.defaultCwd;
    config.defaultModel = applied.defaultModel;
    config.claudeCommand = applied.claudeCommand;
    config.promptsFile = applied.promptsFile;
    config.problems = applied.problems;
  } catch (error) {
    return { ok: false, message: `Could not save ${file}: ${errorMessage(error)}` };
  }
  if (prompts !== null) {
    try {
      writeAtomic(config.promptsFile, prompts);
    } catch (error) {
      return { ok: false, message: `Saved the settings, but could not write ${config.promptsFile}: ${errorMessage(error)}` };
    }
  }
  return { ok: true, message: 'Saved. New workspaces use these now; running terminals keep what they started with.' };
}
